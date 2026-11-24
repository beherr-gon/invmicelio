import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import psycopg
import serial
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("bridge_sensores")

SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/cu.usbserial-0001")
BAUD_RATE = int(os.getenv("BAUD_RATE", "115200"))
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://mi_admin:mi8440@127.0.0.1:5432/mi_local",
)


class ConnectionManager:
    def __init__(self) -> None:
        self.active: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.active.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        dead: list[WebSocket] = []
        for ws in self.active:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


def cargar_mapa_sensores(conn: psycopg.Connection) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute("SELECT codigo, id FROM sensores WHERE activo = TRUE")
        return {row[0]: row[1] for row in cur.fetchall()}


def insertar_lectura(
    conn: psycopg.Connection,
    sensor_id: int,
    valor: float,
    valor_crudo: int | None,
    fecha_hora: datetime,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO lecturas (sensor_id, valor, valor_crudo, fecha_hora)
            VALUES (%s, %s, %s, %s)
            """,
            (sensor_id, valor, valor_crudo, fecha_hora),
        )
    conn.commit()


async def leer_serial_y_procesar() -> None:
    loop = asyncio.get_running_loop()

    while True:
        conn: psycopg.Connection | None = None
        ser: serial.Serial | None = None
        try:
            logger.info("Conectando a PostgreSQL...")
            conn = psycopg.connect(DATABASE_URL)
            mapa_sensores = cargar_mapa_sensores(conn)
            logger.info("Sensores activos cargados: %d", len(mapa_sensores))

            logger.info("Abriendo puerto serial %s a %d baudios...", SERIAL_PORT, BAUD_RATE)
            ser = serial.Serial()
            ser.port = SERIAL_PORT
            ser.baudrate = BAUD_RATE
            ser.timeout = 0.2
            ser.dtr = False
            ser.rts = False
            ser.open()
            await asyncio.sleep(0.5)
            ser.reset_input_buffer()
            logger.info("Escuchando lecturas del ESP32...")

            while True:
                linea_bytes = await loop.run_in_executor(None, ser.readline)
                if not linea_bytes:
                    await asyncio.sleep(0.01)
                    continue

                linea = linea_bytes.decode("utf-8", errors="ignore").strip()
                if not linea:
                    continue
                if not linea.startswith("{"):
                    logger.info("ESP32 [texto]: %s", linea)
                    continue

                try:
                    data = json.loads(linea)
                except json.JSONDecodeError:
                    continue

                if "error" in data:
                    logger.warning("Error reportado por ESP32: %s", data["error"])
                    continue

                codigo = data.get("s")
                valor = data.get("v")
                raw = data.get("raw")

                if not codigo or valor is None:
                    continue

                sensor_id = mapa_sensores.get(codigo)
                if sensor_id is None:
                    mapa_sensores = cargar_mapa_sensores(conn)
                    sensor_id = mapa_sensores.get(codigo)
                    if sensor_id is None:
                        logger.warning("Sensor '%s' no encontrado o inactivo en tabla 'sensores'", codigo)
                        continue

                ahora_utc = datetime.now(timezone.utc)
                valor_crudo_int = int(raw) if raw is not None else None

                await loop.run_in_executor(
                    None,
                    insertar_lectura,
                    conn,
                    sensor_id,
                    float(valor),
                    valor_crudo_int,
                    ahora_utc,
                )

                evento = {
                    "sensor_id": sensor_id,
                    "codigo": codigo,
                    "valor": float(valor),
                    "raw": valor_crudo_int,
                    "fecha_hora": ahora_utc.isoformat(),
                }
                await manager.broadcast(evento)
        except asyncio.CancelledError:
            logger.info("Deteniendo lector serial...")
            raise
        except serial.SerialException as exc:
            logger.warning("No se pudo abrir/leer %s (%s). Reintentando en 3s...", SERIAL_PORT, exc)
            await asyncio.sleep(3)
        except Exception:
            logger.exception("Error en el puente serial -> PostgreSQL. Reintentando en 3s...")
            await asyncio.sleep(3)
        finally:
            if ser is not None and ser.is_open:
                ser.close()
            if conn is not None and not conn.closed:
                conn.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(leer_serial_y_procesar())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Bridge Sensores Micelio", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/ultimas-lecturas")
def get_ultimas_lecturas():
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM vista_ultimas_lecturas")
            cols = [desc[0] for desc in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


@app.get("/api/lecturas")
def get_lecturas(codigo: str | None = None, limit: int = 100):
    limit = max(1, min(limit, 500))
    query = """
        SELECT
            l.id,
            s.id AS sensor_id,
            s.codigo AS codigo_sensor,
            s.nombre_etiqueta,
            ts.nombre AS tipo_sensor,
            a.nombre AS ambiente,
            l.valor,
            ts.unidad_medida,
            l.valor_crudo,
            l.fecha_hora,
            s.ubicacion_hardware
        FROM lecturas l
        JOIN sensores s ON l.sensor_id = s.id
        JOIN tipos_sensor ts ON s.tipo_id = ts.id
        LEFT JOIN ambientes a ON s.ambiente_id = a.id
        {where_clause}
        ORDER BY l.fecha_hora DESC
        LIMIT %s
    """
    params: list[object] = []
    where_clause = ""
    if codigo:
        where_clause = "WHERE s.codigo = %s"
        params.append(codigo)
    params.append(limit)

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(query.format(where_clause=where_clause), params)
            cols = [desc[0] for desc in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


@app.websocket("/ws/lecturas")
async def ws_lecturas(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)
