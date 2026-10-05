TAREA 002_HORNO

Aplicación web estática (HTML + CSS + JS, sin backend) que lee horno_semana.csv, calcula estadísticas diarias, dibuja la serie temporal de temperatura, detecta anomalías de funcionamiento y genera un aviso en lenguaje llano para el operario.

Para la IA que lea esto: este archivo es la fuente de verdad del proyecto. Respeta la arquitectura, los nombres de funciones y los IDs del DOM descritos aquí. Continúa desde la sección Estado. No inventes datos ni causas de avería.

1. Contexto de la tarea
Dataset: 1 semana de un horno industrial, lun 21 – dom 27 sept 2026, 1 registro/hora.
Entrega: lunes 5 oct. Incluye (a) código, (b) página de resultados con gráfica y aviso, (c) nota de qué IA se usó y para qué.
Requisitos funcionales:
Descripción del fichero (pocas líneas).
Por día: temperatura media, máx, mín.
Gráfica de temperatura de toda la semana.
Detectar cuándo el horno funcionó mal + aviso al operario en 3 líneas, sin jerga.
Otros hallazgos relevantes.
Regla de negocio: mié 2026-09-23 06:00–08:00 = parada por mantenimiento programado. La ventana que se excluye del detector va de 06:00 a 09:00, ambas horas incluidas; el registro de las 09:00 sí dice marcha, pero se excluye igualmente por la ventana acordada.
2. Esquema de datos

Fichero: horno_semana.csv (en la raíz del proyecto, junto a index.html; se carga con fetch('horno_semana.csv')) · filas esperadas: 168 (7 × 24).

Columna (CSV)	Campo interno	Tipo	Notas
fecha_hora	ts	Date	Formato YYYY-MM-DD HH:mm (hora con cero inicial, ej. 2026-09-21 00:00). Parsear a mano en hora local.
temperatura_c	temp	number (°C)	Temperatura del horno. Rango visto en las primeras 21 h: ~182–189 °C.
consumo_kw	kw	number (kW)	Consumo eléctrico. Rango visto en las primeras 21 h: ~138–145 kW. 1 h ⇒ kW ≈ kWh.
estado	running	boolean	Valores: marcha ⇒ true; parada ⇒ false (comprobar que no hay otros valores ni mayúsculas/espacios).
Formato real (visto en la hoja de cálculo)
cabecera:           fecha_hora,temperatura_c,consumo_kw,estado
formato fecha:      YYYY-MM-DD HH:mm   (hora con cero inicial: "2026-09-21 00:00", "2026-09-21 10:00")
decimal:            punto ("186.3")
valores de estado:  "marcha" y "parada" (confirmados en el CSV; se normalizan como running true/false)
separador:          coma
filas leídas:       168
muestra:
  fecha_hora,temperatura_c,consumo_kw,estado
  2026-09-21 00:00,184.0,142.5,marcha
  2026-09-21 01:00,186.3,141.9,marcha
  2026-09-21 02:00,184.9,142.9,marcha
  2026-09-21 03:00,186.8,144.7,marcha
  2026-09-21 04:00,185.8,142.2,marcha

Primeras 21 filas (lun 21, 00:00–20:00): todo marcha, temp 182–189 °C, consumo 138–145 kW. Sirven como referencia provisional de funcionamiento normal; confirmar con la semana completa.

Parseo de fecha (importante)

new Date("2026-09-21 00:00") NO es fiable (el formato no es ISO y varía entre navegadores; Safari suele devolver Invalid Date). Parsear con regex:

js
function parseTs(str) {
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null; // registrar como dato inválido
  return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]); // hora local
}
3. Stack
Pieza	Uso
VS Code + Live Server	Servir el proyecto por http:// (con file:// el fetch del CSV falla por CORS).
PapaParse (CDN)	Parseo del CSV (header:true, skipEmptyLines:true, sin delimiter (autodetección) salvo que falle; NO usar dynamicTyping para la fecha).
Chart.js (CDN)	Gráfica de líneas. Opcional: chartjs-plugin-annotation y chartjs-adapter-date-fns (eje temporal).
4. Estructura
horno-linea2/
├── index.html
├── style.css
├── app.js
├── CONTEXTO.md
└── horno_semana.csv
5. Arquitectura (app.js)

Pipeline: fetch → parse → normalizar → analizar → renderizar.

loadData()                     // fetch + Papa.parse → filas crudas
normalize(rows)        → Row[] // { ts:Date, temp:number, kw:number, running:boolean }
                               // usa parseTs(); estado.trim().toLowerCase()==='marcha'
describeFile(rows)     → obj   // n filas, rango fechas, min/max, nº parado/en marcha, nulos
dailyStats(rows, {onlyRunning:boolean}) → DayStat[]  // { dayKey, label, mean, max, min, n }
detectAnomalies(rows)  → Anomaly[]   // { start, end, type, severity, description }
extraFindings(rows)    → obj         // kWh/día, corr(temp,kw), deriva semanal, calidad del dato
buildOperatorNotice(anomalies) → string[3]
render*()                      // renderFile, renderDaily, renderChart, renderAnomalies, ...
Convenciones
dayKey = YYYY-MM-DD construido con getters locales (getFullYear/getMonth/getDate). No usar toISOString(): convierte a UTC y puede mover el registro al día anterior.
Redondeo a 1 decimal solo al mostrar, nunca en el cálculo.
La tabla diaria calcula media, máxima y mínima con todas las horas válidas del día. La columna "Horas en marcha" muestra las horas de marcha sobre el total registrado (por ejemplo, 21/24). Si hay horas paradas dentro de la ventana de mantenimiento, marca el día y añade una nota dinámica con el número de horas.
6. Algoritmos
6.1 Estadísticas diarias

Agrupar por dayKey → mean, max, min de temp usando todas las filas válidas del día; calcular además el número de filas en marcha y el total de horas registradas.

6.2 Detección de anomalías

Referencia estadística: sobre horas running=true y fuera del mantenimiento, mediana y MAD de temp y kw ⇒ rango normal [lo, hi]. Reglas (activar las que apliquen a los datos):

ID	Regla	Posible significado
R1	running y temp fuera de [lo, hi]	Sobrecalentamiento / enfriamiento
R2	abs(temp[i] - temp[i-1]) ≥ umbral	Salto brusco: sensor o control
R3	estado != marcha fuera de la ventana de mantenimiento	Parada no programada
R4	running=false y kw alto, o running y kw≈0	Datos incoherentes
R5	arranque por debajo del límite habitual y subida <5 °C en las 3 horas siguientes	Fallo de calentamiento
R6	temp idéntica durante 4 lecturas horarias consecutivas	Sensor congelado
R7	Huecos de timestamps (los duplicados se contabilizan en calidad)	Fallo de registro
Exclusión obligatoria: ignorar 2026-09-23 06:00 ≤ ts ≤ 09:00 (mantenimiento).
Agrupar horas consecutivas en un único evento {start, end, ...}. La tabla puede mostrar además la parada por mantenimiento como evento informativo, con el tramo realmente parado; esta fila no se considera anomalía ni entra en el aviso.
Reglas activas: R1, R2, R3, R5, R6 y huecos de R7. R4 no está activada. Parámetros: lo y hi se calculan desde el CSV; salto ≥10 °C; sensor plano = 4 lecturas consecutivas idénticas; arranque sin subida ≥5 °C en 3 horas. El detector de arranque solo actúa si empieza por debajo del límite inferior habitual.
6.3 Aviso al operario

Exactamente 3 líneas: (1) día, franja térmica real sin horas ya recuperadas, valor extremo y valor habitual aproximado; (2) consumo máximo frente al habitual si subió mientras bajaba la temperatura, sin analogías, o frase alternativa sencilla; (3) revisar el horno y el sensor antes del próximo turno y avisar si se repite, aclarando que los datos no permiten saber la causa.

6.4 Hallazgos extra

kWh por día sumando todas las filas, incluidas las paradas · correlación temp–kw en marcha fuera del mantenimiento, comparada con la correlación al quitar las filas del evento más grave y explicación de la diferencia · deriva de la temperatura media a lo largo de la semana · calidad del dato (nulos, duplicados, valores imposibles).

7. UI (IDs del DOM)
Sección	ID	Contenido
Qué contiene el fichero	#sec-fichero	Salida de describeFile
Resumen por día	#sec-diario	<table> con media / máx / mín
Gráfica semanal	#sec-grafica → <canvas id="chart-temp">	Línea de temp; marcar horas paradas y anomalías
Anomalías	#sec-anomalias	Tabla de eventos
Aviso al operario	#sec-aviso	3 líneas, tarjeta destacada
Otros hallazgos	#sec-extra	3–4 conclusiones
Uso de IA	#sec-ia	Texto de la entrega

CSS: una columna, tarjetas por sección, @media print para que todo quepa en 1 hoja A4.

8. Estado (actualizar al cerrar cada sesión)
 [x] F0 Estructura y CDNs (Live Server pendiente de probar)
 [x] F1 Lectura del CSV: 168 filas y columnas esperadas
 [x] F2 describeFile + sección fichero
 [x] F3 dailyStats + una tabla con todas las horas
 [x] F4 Gráfica Chart.js
 [x] F5 detectAnomalies con exclusión de mantenimiento
 [x] F6 buildOperatorNotice (exactamente tres líneas)
 [x] F7 extraFindings
 [x] F8 CSS adaptable + reglas de impresión (impresión A4 pendiente de comprobar)
 [x] F9 Sección "Uso de IA"

Ahora mismo: aplicación implementada. El CSV contiene 168 registros: 165 en marcha y 3 paradas (mié 23, 06:00–08:00); la fila de las 09:00 dice marcha, 188,4 °C y 144,2 kW. La ventana de mantenimiento incluye las 09:00, por tanto esa lectura queda fuera del detector; no aparece anomalía en las horas posteriores del miércoles. El resumen diario usa todas las horas: el miércoles su media es 167,4 °C, máxima 188,4 °C, mínima 44,2 °C y horas en marcha 21/24; incluye una nota generada con las 3 horas paradas del mantenimiento. La anomalía más grave es el viernes 25: la temperatura estuvo fuera del rango entre las 14:00 y las 19:00 (hasta 157,5 °C, frente a la mediana habitual de 185,1 °C); a las 20:00 ya había vuelto al rango. El consumo subió en ese episodio. El consumo diario ahora suma todas las lecturas, incluso paradas. La correlación temperatura–consumo en horas en marcha pasa de −0,6 con el evento a +0,6 sin él, porque durante ese episodio subió el consumo mientras bajaba la temperatura. En los datos actuales no se activan las reglas de sensor plano ni de arranque sin calentamiento. Pendiente: validar Live Server y comprobar PDF en una hoja.

9. Decisiones
Tema	Decisión	Motivo
Estadísticas diarias	media, máxima y mínima con todas las horas registradas	La columna de horas en marcha muestra marcha/total (por ejemplo, 21/24); las paradas de mantenimiento se indican con etiqueta y nota dinámica.
Método de rango normal	mediana ± 3 × 1,4826 × MAD	Robusto ante valores extremos; se calcula en marcha fuera de mantenimiento. Para este CSV: temperatura 179,3–190,9 °C y consumo 136,3–147,8 kW.
Umbrales	Temperatura/consumo fuera de límites robustos; salto horario ≥10 °C; sensor plano desde 4 lecturas; arranque: subida <5 °C en 3 h	Los límites exactos se calculan desde el CSV y se muestran en la página; las reglas de sensor plano y arranque también se muestran en el método. Mantenimiento del mié 23 06:00–09:00 excluido inclusivamente; el registro de las 09:00 está en marcha, pero se excluye por la ventana. La etiqueta "variación importante" se muestra si la temperatura queda ≥10 °C fuera del límite robusto; "variación leve" se reserva para exceso de consumo <1 kW cuando esa es la única señal.
Aviso al operario	Tres líneas: qué pasó, dato de consumo comparado con el habitual y recomendación	La primera indica la franja real sin horas recuperadas, el extremo y lo normal aproximado. La segunda compara el consumo máximo con el habitual cuando sube mientras baja la temperatura, sin analogías. La tercera recomienda revisar horno y sensor antes del próximo turno y avisar si se repite, sin afirmar la causa.
Consumo y correlación	Consumo diario con todas las filas; correlación operativa con y sin el evento más grave	La correlación se calcula sobre horas en marcha fuera de mantenimiento; al comparar, se quitan del cálculo las filas del evento completo y se explica cómo cambia la relación.
10. Checklist de entrega
 [ ] Consola (F12) sin errores con Live Server (pendiente)
 [x] CSV inspeccionado: 168 filas; estados: 165 marcha y 3 parada
 [x] Contrastar la media, máxima y mínima del miércoles con todas las horas registradas
 [x] La parada 06–08 y el registro de las 09:00 están dentro de la exclusión de mantenimiento (06–09 inclusivo)
 [x] En el informe: consumo fuera de rango jue 24 06:00; evento más grave vie 25 14:00–20:00; sin señal de sensor plano ni arranque sin calentamiento en estos datos
 [x] Aviso de exactamente 3 líneas: franja térmica real, extremo frente a lo normal, consumo si corresponde y recomendación sin afirmar la causa
 [x] Consumo diario suma todas las lecturas; correlación compara valores con y sin el evento más grave y explica el cambio
 [ ] Impresión/PDF en una hoja (pendiente)
 [x] Nota de uso de IA incluida
11. Registro de uso de IA
IA	Para qué	Qué verifiqué yo
Claude	Hoja de ruta y archivo CONTEXTO.md.	La persona autora revisa las decisiones y contrasta las salidas con el CSV.
GitHub Copilot	Estructura HTML/CSS/JS y análisis del CSV basado en reglas explícitas.	Se contrastaron las filas y los estados con el CSV original (168 filas; 165 en marcha y 3 paradas). Se probaron las tablas y anomalías en el navegador local. Pendientes: prueba específica de consola Live Server e impresión/PDF.
12. Reglas para el asistente
Entrega el código completo del archivo afectado e indica su ruta.
No renombres funciones, IDs ni ficheros sin avisar.
Explica brevemente cada cambio; el autor está aprendiendo.
Ante dudas sobre el formato del CSV, pregunta; no asumas.