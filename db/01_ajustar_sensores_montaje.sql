-- Ajusta unidades, etiquetas y ubicaciones de hardware al montaje real de pruebas (ESP32)

UPDATE tipos_sensor
SET unidad_medida = '% HR'
WHERE codigo = 'HUM_AMB';

-- El código actual del ESP32 envía el voltaje del MQ-7 (ads.computeVolts), aún sin curva a ppm
UPDATE tipos_sensor
SET nombre = 'Gas / CO (MQ-7)',
    magnitud = 'Voltaje Gas (MQ-7)',
    unidad_medida = 'V'
WHERE codigo = 'GAS_CO2';

UPDATE sensores
SET ubicacion_hardware = 'TCA1_CH0 -> ADS1115_1_A0'
WHERE codigo = 'SUELO_01';

UPDATE sensores
SET nombre_etiqueta = 'Sensor Gas MQ-7 #01',
    ubicacion_hardware = 'TCA1_CH0 -> ADS1115_1_A1 (5V ext)'
WHERE codigo = 'CO2_01';

UPDATE sensores
SET nombre_etiqueta = 'Electrodo Micelio AD8232 #01',
    ubicacion_hardware = 'TCA1_CH0 -> ADS1115_1_A2 (3.3V)'
WHERE codigo = 'BIO_ECG_01';

UPDATE sensores
SET ubicacion_hardware = 'ESP32_GPIO4 (1-Wire, pull-up 4.7kΩ)'
WHERE codigo = 'TEMP_SUST_01';

UPDATE sensores
SET ubicacion_hardware = 'ESP32_GPIO18 (DHT22)'
WHERE codigo IN ('DHT22_01_TEMP', 'DHT22_01_HUM');
