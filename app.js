const MAINTENANCE_START = new Date(2026, 8, 23, 6, 0);
const MAINTENANCE_END = new Date(2026, 8, 23, 9, 0);
const EXPECTED_HOURS = 168;
const REQUIRED_COLUMNS = ["fecha_hora", "temperatura_c", "consumo_kw", "estado"];
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTH_NAMES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
let temperatureChart = null;
let normalizedRows = [];
let latestAnomalies = [];
let analysisParameters = null;

function parseTs(str) {
  if (typeof str !== "string") return null;
  const match = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const ts = new Date(year, month - 1, day, hour, minute);
  if (ts.getFullYear() !== year || ts.getMonth() !== month - 1 || ts.getDate() !== day || ts.getHours() !== hour || ts.getMinutes() !== minute) return null;
  return ts;
}

function dayKey(ts) {
  return `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")}`;
}

function isMaintenance(ts) {
  return ts >= MAINTENANCE_START && ts <= MAINTENANCE_END;
}

function normalize(rows) {
  return rows.map((raw, index) => {
    const ts = parseTs(raw.fecha_hora);
    const temp = raw.temperatura_c === "" || raw.temperatura_c == null ? NaN : Number(raw.temperatura_c);
    const kw = raw.consumo_kw === "" || raw.consumo_kw == null ? NaN : Number(raw.consumo_kw);
    const rawState = typeof raw.estado === "string" ? raw.estado.trim().toLowerCase() : "";
    const state = rawState === "parada" ? "parado" : rawState;
    return { ts, temp, kw, running: state === "marcha", state, index };
  });
}

function isValidRow(row) {
  return row.ts instanceof Date && Number.isFinite(row.ts.getTime()) && Number.isFinite(row.temp) && Number.isFinite(row.kw) && (row.state === "marcha" || row.state === "parado");
}

function validRows(rows) {
  return rows.filter(isValidRow).sort((a, b) => a.ts - b.ts);
}

function describeFile(rows) {
  const valid = validRows(rows);
  const stops = rows.filter((row) => row.state === "parado").length;
  const invalid = rows.filter((row) => !isValidRow(row)).length;
  const duplicates = countDuplicates(valid);
  const first = valid[0]?.ts;
  const last = valid.at(-1)?.ts;
  const outOfRange = rows.filter((row) => (Number.isFinite(row.temp) && (row.temp < -50 || row.temp > 500)) || (Number.isFinite(row.kw) && (row.kw < 0 || row.kw > 1000))).length;
  return { n: rows.length, valid: valid.length, first, last, minTemp: valid.length ? Math.min(...valid.map((row) => row.temp)) : null, maxTemp: valid.length ? Math.max(...valid.map((row) => row.temp)) : null, stops, running: rows.filter((row) => row.state === "marcha").length, invalid, duplicates, outOfRange };
}

function countDuplicates(rows) {
  let duplicates = 0;
  const seen = new Set();
  for (const row of rows) {
    const key = row.ts.getTime();
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  return duplicates;
}

function dailyStats(rows, { onlyRunning = true } = {}) {
  const groups = new Map();
  for (const row of validRows(rows)) {
    if (onlyRunning && !row.running) continue;
    const key = dayKey(row.ts);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
    const temps = values.map((row) => row.temp);
    return { dayKey: key, label: `${DAY_NAMES[values[0].ts.getDay()]} ${values[0].ts.getDate()}`, mean: average(temps), max: Math.max(...temps), min: Math.min(...temps), n: values.length };
  });
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustBounds(values) {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  const spread = 1.4826 * mad;
  return { center, mad, lo: center - 3 * spread, hi: center + 3 * spread };
}

function detectAnomalies(rows) {
  const ordered = validRows(rows);
  const inScope = ordered.filter((row) => row.running && !isMaintenance(row.ts));
  const tempBounds = robustBounds(inScope.map((row) => row.temp));
  const kwBounds = robustBounds(inScope.map((row) => row.kw));
  const flags = new Map();
  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index];
    if (isMaintenance(row.ts)) continue;
    const reasons = [];
    if (!row.running) reasons.push("Parada fuera de la ventana programada");
    if (row.running && (row.temp < tempBounds.lo || row.temp > tempBounds.hi)) reasons.push("Temperatura fuera del rango habitual");
    if (row.running && (row.kw < kwBounds.lo || row.kw > kwBounds.hi)) reasons.push("Consumo fuera del rango habitual");
    const previous = ordered[index - 1];
    if (previous && !isMaintenance(previous.ts) && Math.abs(row.ts - previous.ts) === 3600000 && Math.abs(row.temp - previous.temp) >= 10) reasons.push("Cambio horario de temperatura de al menos 10 °C");
    if (reasons.length) flags.set(row.ts.getTime(), { row, reasons });
  }
  const events = [];
  for (const { row, reasons } of flags.values()) {
    const current = events.at(-1);
    if (current && row.ts - current.end === 3600000) {
      current.end = row.ts;
      current.rows.push(row);
      current.reasons = [...new Set([...current.reasons, ...reasons])];
    } else {
      events.push({ start: row.ts, end: row.ts, rows: [row], reasons: [...new Set(reasons)], type: "Funcionamiento fuera del patrón", severity: "revisar" });
    }
  }
  const gaps = findGaps(ordered);
  for (const gap of gaps) events.push({ start: gap.after, end: gap.before, rows: [], reasons: ["Falta uno o más registros horarios"], type: "Hueco de registro", severity: "dato" });
  analysisParameters = { tempBounds, kwBounds, jump: 10, gaps };
  return events.sort((a, b) => a.start - b.start);
}

function findGaps(rows) {
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    const difference = rows[index].ts - rows[index - 1].ts;
    if (difference > 3600000) gaps.push({ after: new Date(rows[index - 1].ts.getTime() + 3600000), before: rows[index].ts });
  }
  return gaps;
}

function extraFindings(rows) {
  const valid = validRows(rows);
  const working = valid.filter((row) => row.running && !isMaintenance(row.ts));
  const energyByDay = new Map();
  for (const row of valid.filter((item) => item.running)) energyByDay.set(dayKey(row.ts), (energyByDay.get(dayKey(row.ts)) || 0) + row.kw);
  const daily = dailyStats(rows, { onlyRunning: true });
  const firstDay = daily[0];
  const lastDay = daily.at(-1);
  const correlation = pearson(working.map((row) => row.temp), working.map((row) => row.kw));
  const quality = describeFile(rows);
  return { energyByDay, daily, firstDay, lastDay, correlation, quality };
}

function pearson(xs, ys) {
  if (xs.length < 2 || xs.length !== ys.length) return NaN;
  const meanX = average(xs);
  const meanY = average(ys);
  const numerator = xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index] - meanY), 0);
  const denominator = Math.sqrt(xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0) * ys.reduce((sum, value) => sum + (value - meanY) ** 2, 0));
  return denominator ? numerator / denominator : NaN;
}

function buildOperatorNotice(anomalies) {
  if (!anomalies.length) return ["No se detectaron lecturas fuera de los criterios usados esta semana.", "Las mediciones se mantuvieron dentro de la banda habitual calculada.", "Continúe con las comprobaciones normales del turno."];
  const event = [...anomalies].sort((a, b) => {
    const aDuration = a.rows.length;
    const bDuration = b.rows.length;
    if (aDuration !== bDuration) return bDuration - aDuration;
    return b.reasons.length - a.reasons.length;
  })[0];
  const temps = event.rows.map((row) => row.temp);
  const min = temps.length ? Math.min(...temps) : null;
  const max = temps.length ? Math.max(...temps) : null;
  const first = formatDateTime(event.start);
  const last = formatDateTime(event.end);
  const when = event.start.getTime() === event.end.getTime() ? first : `${first} a ${last}`;
  const detail = min == null ? event.reasons[0] : `temperatura ${formatNumber(min)}–${formatNumber(max)} °C`;
  return [
    `El ${when} se observó ${detail}${event.reasons.some((reason) => reason.includes("Consumo")) ? " y consumo elevado" : ""}.`,
    "La lectura se apartó del comportamiento que venía mostrando el horno.",
    "Revise el equipo y las mediciones de ese periodo; no se puede confirmar la causa solo con estos datos."
  ];
}

async function loadData() {
  const status = document.querySelector("#load-status");
  try {
    const response = await fetch("horno_semana.csv");
    if (!response.ok) throw new Error(`No se pudo abrir horno_semana.csv (HTTP ${response.status}).`);
    if (!window.Papa) throw new Error("No se pudo cargar PapaParse. Compruebe la conexión a Internet.");
    const csvText = await response.text();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    if (parsed.errors.length) throw new Error(`CSV no válido: ${parsed.errors[0].message}`);
    const headers = parsed.meta.fields || [];
    const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
    if (missing.length) throw new Error(`Faltan columnas requeridas: ${missing.join(", ")}.`);
    normalizedRows = normalize(parsed.data);
    latestAnomalies = detectAnomalies(normalizedRows);
    renderFile(describeFile(normalizedRows));
    renderDaily(dailyStats(normalizedRows, { onlyRunning: true }));
    renderChart(validRows(normalizedRows), latestAnomalies);
    renderAnomalies(latestAnomalies);
    renderNotice(buildOperatorNotice(latestAnomalies));
    renderExtra(extraFindings(normalizedRows));
    status.classList.add("is-ready");
    status.lastElementChild.textContent = `${normalizedRows.length} filas leídas`;
  } catch (error) {
    status.classList.add("is-error");
    status.lastElementChild.textContent = "No se pudo cargar el CSV";
    document.querySelector("#file-content").innerHTML = `<p>${escapeHtml(error.message)} Abra la página con Live Server y confirme que el CSV está junto a index.html.</p>`;
    document.querySelector("#operator-notice").innerHTML = "<p>No se generó un aviso porque no fue posible leer los datos.</p><p>El informe no dispone de registros válidos.</p><p>Compruebe el CSV y vuelva a cargar la página.</p>";
  }
}

function renderFile(info) {
  const dateRange = info.first && info.last ? `${formatDate(info.first)} – ${formatDate(info.last)}` : "sin fechas válidas";
  document.querySelector("#file-content").innerHTML = `<p><strong>horno_semana.csv</strong> · ${dateRange}. Se leyeron ${info.n} filas: ${info.running} en marcha y ${info.stops} paradas. Temperatura registrada: ${formatNumber(info.minTemp)}–${formatNumber(info.maxTemp)} °C.</p><div class="file-pills"><span class="file-pill ${info.n === EXPECTED_HOURS ? "" : "warn"}">${info.n}/${EXPECTED_HOURS} filas</span><span class="file-pill">${info.invalid} inválidas</span><span class="file-pill">${info.duplicates} duplicadas</span><span class="file-pill">${info.outOfRange} fuera de rango físico</span></div>`;
}

function renderDaily(stats) {
  const body = document.querySelector("#daily-body");
  body.innerHTML = stats.length ? stats.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>${formatNumber(item.mean)}</td><td>${formatNumber(item.max)}</td><td>${formatNumber(item.min)}</td><td>${item.n}</td></tr>`).join("") : '<tr><td colspan="5" class="empty">No hay temperaturas válidas.</td></tr>';
}

function renderChart(rows, anomalies) {
  const canvas = document.querySelector("#chart-temp");
  if (!window.Chart) {
    document.querySelector("#chart-range").textContent = "No se pudo cargar Chart.js";
    return;
  }
  const flagged = new Set(anomalies.flatMap((event) => event.rows.map((row) => row.ts.getTime())));
  const colors = rows.map((row) => flagged.has(row.ts.getTime()) ? "#c3543e" : isMaintenance(row.ts) || !row.running ? "#d7a83e" : "#376b54");
  const ctx = canvas.getContext("2d");
  if (temperatureChart) temperatureChart.destroy();
  temperatureChart = new Chart(ctx, {
    type: "line",
    data: { labels: rows.map((row) => row.ts), datasets: [{ data: rows.map((row) => row.temp), borderColor: "#376b54", borderWidth: 1.5, pointRadius: rows.map((row) => isMaintenance(row.ts) || !row.running || flagged.has(row.ts.getTime()) ? 3.5 : 0), pointHoverRadius: 5, pointBackgroundColor: colors, pointBorderColor: colors, tension: 0.18, spanGaps: false }] },
    options: { maintainAspectRatio: false, animation: { duration: 450 }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => formatDateTime(items[0].label), label: (item) => `${formatNumber(item.raw)} °C · ${rows[item.dataIndex].running ? "marcha" : "parado"}` } } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, color: "#68716b", callback: (value) => { const ts = rows[value]?.ts; return ts ? `${ts.getDate()} ${MONTH_NAMES[ts.getMonth()]}` : ""; } }, border: { color: "#d9ddd3" } }, y: { title: { display: true, text: "°C", color: "#68716b", font: { family: "DM Mono" } }, grid: { color: "#e5e7e0" }, ticks: { color: "#68716b", font: { family: "DM Mono", size: 10 } }, border: { display: false } } } }
  });
}

function renderAnomalies(anomalies) {
  const body = document.querySelector("#anomaly-body");
  body.innerHTML = anomalies.length ? anomalies.map((event) => `<tr><td>${formatDateTime(event.start)}${event.end.getTime() !== event.start.getTime() ? `<br>— ${formatDateTime(event.end)}` : ""}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(describeEvent(event))}</td></tr>`).join("") : '<tr><td colspan="3" class="empty">No se detectaron anomalías con estos criterios.</td></tr>';
  if (analysisParameters) {
    const { tempBounds, kwBounds, jump } = analysisParameters;
    document.querySelector("#method-note").textContent = `Criterio: mediana ± 3 × 1,4826 × MAD en horas en marcha fuera de mantenimiento. Temperatura ${formatNumber(tempBounds.lo)}–${formatNumber(tempBounds.hi)} °C; consumo ${formatNumber(kwBounds.lo)}–${formatNumber(kwBounds.hi)} kW; salto horario ≥ ${jump} °C. El intervalo programado del miércoles 06:00–09:00 se excluye del detector.`;
  }
}

function describeEvent(event) {
  if (!event.rows.length) return event.reasons.join("; ");
  const temps = event.rows.map((row) => row.temp);
  const kws = event.rows.map((row) => row.kw);
  return `${[...new Set(event.reasons)].join("; ")}. Temperatura ${formatNumber(Math.min(...temps))}–${formatNumber(Math.max(...temps))} °C; consumo ${formatNumber(Math.min(...kws))}–${formatNumber(Math.max(...kws))} kW.`;
}

function renderNotice(lines) {
  document.querySelector("#operator-notice").innerHTML = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function renderExtra(findings) {
  const energy = [...findings.energyByDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxEnergy = energy.reduce((best, item) => item[1] > best[1] ? item : best, energy[0] || ["", 0]);
  const drift = findings.firstDay && findings.lastDay ? findings.lastDay.mean - findings.firstDay.mean : NaN;
  const quality = findings.quality;
  const correlationText = Number.isFinite(findings.correlation) ? `${formatNumber(findings.correlation)} (Pearson, en marcha)` : "no calculable";
  const items = [
    `Consumo estimado: ${energy.map(([key, value]) => `${key.slice(5)} ${formatNumber(value)} kWh`).join(" · ")}. Suma horaria aproximada; incluye solo registros en marcha. Mayor consumo: ${maxEnergy[0] ? `${maxEnergy[0]} (${formatNumber(maxEnergy[1])} kWh)` : "no calculable"}.`,
    `Correlación temperatura–consumo: ${correlationText}. La correlación no demuestra causalidad.`,
    `Cambio entre media del primer y último día: ${Number.isFinite(drift) ? `${drift > 0 ? "+" : ""}${formatNumber(drift)} °C` : "no calculable"}.`,
    `Calidad: ${quality.invalid} fila(s) con campos inválidos, ${quality.duplicates} duplicada(s), ${analysisParameters?.gaps.length || 0} hueco(s) y ${quality.outOfRange} valor(es) fuera de los límites de revisión usados (−50–500 °C; 0–1000 kW).`
  ];
  document.querySelector("#extra-content").innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function formatDate(ts) {
  return `${String(ts.getDate()).padStart(2, "0")} ${MONTH_NAMES[ts.getMonth()]} ${ts.getFullYear()}`;
}

function formatDateTime(ts) {
  return `${DAY_NAMES[ts.getDay()]} ${String(ts.getDate()).padStart(2, "0")} ${MONTH_NAMES[ts.getMonth()]} ${String(ts.getHours()).padStart(2, "0")}:00`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

document.addEventListener("DOMContentLoaded", loadData);