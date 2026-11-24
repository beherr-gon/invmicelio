import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { SensoresRealtimeService, UltimaLectura } from './sensores-realtime.service';

@Component({
  imports: [],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnInit, OnDestroy {
  private readonly realtime = inject(SensoresRealtimeService);

  readonly sensores = this.realtime.sensores;
  readonly historial = this.realtime.historial;
  readonly estadoConexion = this.realtime.estadoConexion;
  readonly cargandoHistorial = this.realtime.cargandoHistorial;
  readonly errorCarga = this.realtime.errorCarga;

  readonly sensorSeleccionado = signal<string>('ALL');
  readonly soloConDatos = signal<boolean>(true);

  readonly sensoresConDatos = computed(() =>
    this.sensores().filter((s) => s.valor !== null)
  );

  readonly sensoresSinDatos = computed(() =>
    this.sensores().filter((s) => s.valor === null)
  );

  readonly resumenVisible = computed<UltimaLectura[]>(() => {
    const todos = this.sensores();
    if (!this.soloConDatos()) {
      return todos;
    }
    const activos = todos.filter((s) => s.valor !== null);
    return activos.length > 0 ? activos : todos;
  });

  readonly detalleSensorActual = computed<UltimaLectura | null>(() => {
    const codigo = this.sensorSeleccionado();
    if (codigo === 'ALL') return null;
    return this.sensores().find((s) => s.codigo_sensor === codigo) ?? null;
  });

  private readonly numberFormatter = new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  private readonly dateTimeFormatter = new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });

  ngOnInit(): void {
    void this.realtime.iniciar();
  }

  ngOnDestroy(): void {
    this.realtime.cerrar();
  }

  onSeleccionarSensor(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const codigo = select.value;
    this.sensorSeleccionado.set(codigo);
    if (codigo === 'ALL') {
      void this.realtime.cargarHistorialSensor(null);
    } else {
      void this.realtime.cargarHistorialSensor(codigo, 100);
    }
  }

  onToggleSoloConDatos(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.soloConDatos.set(input.checked);
  }

  formatearValor(valor: number | null, unidad: string): string {
    if (valor === null || valor === undefined || Number.isNaN(valor)) {
      return 'Sin lectura';
    }
    const numero = this.numberFormatter.format(valor);
    return unidad ? `${numero} ${unidad}` : numero;
  }

  formatearFecha(iso: string | null): string {
    if (!iso) return '—';
    const fecha = new Date(iso);
    if (Number.isNaN(fecha.getTime())) return iso;
    return this.dateTimeFormatter.format(fecha);
  }
}
