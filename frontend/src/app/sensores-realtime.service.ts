import { Injectable, signal } from '@angular/core';

export interface UltimaLectura {
  sensor_id: number;
  codigo_sensor: string;
  nombre_etiqueta: string;
  codigo_tipo: string;
  tipo_sensor: string;
  codigo_ambiente: string | null;
  ambiente: string | null;
  valor: number | null;
  unidad_medida: string;
  fecha_hora: string | null;
  ubicacion_hardware: string | null;
}

export interface LecturaHistorial {
  id: number | string;
  sensor_id: number;
  codigo_sensor: string;
  nombre_etiqueta: string;
  tipo_sensor: string;
  ambiente: string | null;
  valor: number;
  unidad_medida: string;
  valor_crudo: number | null;
  fecha_hora: string;
  ubicacion_hardware: string | null;
}

interface EventoWs {
  sensor_id: number;
  codigo: string;
  valor: number;
  raw?: number | null;
  fecha_hora: string;
}

export type EstadoConexion = 'conectando' | 'conectado' | 'desconectado';

@Injectable({ providedIn: 'root' })
export class SensoresRealtimeService {
  private readonly baseUrl = this.resolverBaseUrl();
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private cerradoManual = false;
  private codigoHistorialActivo: string | null = null;

  readonly sensores = signal<UltimaLectura[]>([]);
  readonly historial = signal<LecturaHistorial[]>([]);
  readonly estadoConexion = signal<EstadoConexion>('conectando');
  readonly cargandoHistorial = signal<boolean>(false);
  readonly errorCarga = signal<string | null>(null);

  private resolverBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location?.hostname) {
      const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
      return `${proto}//${window.location.hostname}:8000`;
    }
    return 'http://127.0.0.1:8000';
  }

  async iniciar(): Promise<void> {
    this.cerradoManual = false;
    await this.cargarUltimasLecturas();
    this.conectarWebSocket();
  }

  async cargarUltimasLecturas(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ultimas-lecturas`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const filas: UltimaLectura[] = await res.json();
      const normalizadas = filas.map((f) => ({
        ...f,
        valor: f.valor === null || f.valor === undefined ? null : Number(f.valor),
      }));
      this.sensores.set(normalizadas);
      this.errorCarga.set(null);
    } catch (err) {
      this.errorCarga.set(
        `No se pudo conectar al backend (${this.baseUrl}). Verifica que uvicorn esté corriendo.`
      );
      console.error('Error cargando últimas lecturas:', err);
    }
  }

  async cargarHistorialSensor(codigo: string | null, limit = 100): Promise<void> {
    this.codigoHistorialActivo = codigo;
    if (!codigo) {
      this.historial.set([]);
      return;
    }

    this.cargandoHistorial.set(true);
    try {
      const params = new URLSearchParams({ codigo, limit: String(limit) });
      const res = await fetch(`${this.baseUrl}/api/lecturas?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const filas: LecturaHistorial[] = await res.json();
      if (this.codigoHistorialActivo !== codigo) {
        return;
      }
      this.historial.set(
        filas.map((f) => ({
          ...f,
          valor: Number(f.valor),
        }))
      );
      this.errorCarga.set(null);
    } catch (err) {
      this.errorCarga.set(`Error al cargar el historial de ${codigo}.`);
      console.error('Error cargando historial:', err);
    } finally {
      this.cargandoHistorial.set(false);
    }
  }

  private conectarWebSocket(): void {
    if (this.cerradoManual) return;

    this.estadoConexion.set('conectando');
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws/lecturas';
    const ws = new WebSocket(wsUrl);
    this.socket = ws;

    ws.onopen = () => {
      this.estadoConexion.set('conectado');
      this.errorCarga.set(null);
    };

    ws.onmessage = (event) => {
      try {
        const dato: EventoWs = JSON.parse(event.data);
        this.aplicarLecturaEnVivo(dato);
      } catch (err) {
        console.error('Mensaje WebSocket inválido:', err);
      }
    };

    ws.onclose = () => {
      this.estadoConexion.set('desconectado');
      if (!this.cerradoManual) {
        this.reconnectTimer = setTimeout(() => this.conectarWebSocket(), 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private aplicarLecturaEnVivo(dato: EventoWs): void {
    let sensorMeta: UltimaLectura | undefined;

    this.sensores.update((lista) =>
      lista.map((s) => {
        if (s.codigo_sensor === dato.codigo) {
          const actualizado: UltimaLectura = {
            ...s,
            valor: Number(dato.valor),
            fecha_hora: dato.fecha_hora,
          };
          sensorMeta = actualizado;
          return actualizado;
        }
        return s;
      })
    );

    if (this.codigoHistorialActivo && this.codigoHistorialActivo === dato.codigo) {
      const nuevaFila: LecturaHistorial = {
        id: `ws-${dato.codigo}-${dato.fecha_hora}`,
        sensor_id: dato.sensor_id,
        codigo_sensor: dato.codigo,
        nombre_etiqueta: sensorMeta?.nombre_etiqueta ?? dato.codigo,
        tipo_sensor: sensorMeta?.tipo_sensor ?? '',
        ambiente: sensorMeta?.ambiente ?? null,
        valor: Number(dato.valor),
        unidad_medida: sensorMeta?.unidad_medida ?? '',
        valor_crudo: dato.raw ?? null,
        fecha_hora: dato.fecha_hora,
        ubicacion_hardware: sensorMeta?.ubicacion_hardware ?? null,
      };
      this.historial.update((filas) => [nuevaFila, ...filas].slice(0, 200));
    }
  }

  cerrar(): void {
    this.cerradoManual = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
  }
}
