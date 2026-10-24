(function () {
  "use strict";

  const E = window.IOEngine;
  const Q = window.IOQuestionEngine;
  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const fmt = (value, digits = 4) => Number(value).toLocaleString("es-GT", { maximumFractionDigits: digits });
  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);

  const state = {
    identity: {
      memberOne: "",
      memberTwo: "",
      course: "Investigación de Operaciones",
      section: "",
      ...(window.PROJECT_IDENTITY || {}),
    },
    practice: { current: 0, correct: [], generated: null },
    conversation: [],
    chatContext: Q.createContext(),
  };

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove("show"), 2700);
  }

  function showView(name) {
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $$(".jump").forEach((button) => button.addEventListener("click", () => showView(button.dataset.target)));

  function suggestionMarkup(response) {
    let suggestions = response.suggestions || [];
    if (!suggestions.length && response.type === "calculation") suggestions = ["¿Cómo lo calculaste?", "¿Y la mitad?", "Dame otro ejemplo"];
    if (!suggestions.length && response.type === "concept") suggestions = ["Explícamelo más sencillo", "Dame otro ejemplo"];
    if (!suggestions.length && ["lp", "eoq", "transport", "assignment"].includes(response.type)) suggestions = ["¿Cómo llegaste?", "Dame otro ejemplo"];
    if (!suggestions.length) return "";
    return `<div class="chat-suggestions" aria-label="Opciones para continuar">${suggestions.map((question) => `<button class="chat-quick" type="button" data-question="${escapeHtml(question)}">${escapeHtml(question)}</button>`).join("")}</div>`;
  }

  function answerMarkup(response) {
    if (response.type === "concept" || response.type === "conversation") {
      return `<p><strong>${escapeHtml(response.title)}</strong></p><p>${escapeHtml(response.answer)}</p>${suggestionMarkup(response)}`;
    }
    if (response.type === "calculation") {
      const result = response.resultLabel || `Resultado = ${fmt(response.value, 8)}`;
      return `<p><strong>${escapeHtml(response.title)}</strong></p><div class="chat-formula">${escapeHtml(response.expression)}</div><div class="chat-result">${escapeHtml(result)}</div>${response.steps?.length ? `<ol>${response.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : ""}${suggestionMarkup(response)}`;
    }
    if (response.type === "clarification") {
      return `<div class="chat-warning"><strong>Necesito un dato más.</strong> ${escapeHtml(response.message)}</div>${response.example ? `<p><small>${escapeHtml(response.example)}</small></p>` : ""}`;
    }
    if (response.type === "error") {
      return `<div class="chat-warning"><strong>Revisa los datos.</strong> ${escapeHtml(response.message)}</div>`;
    }
    if (response.type === "lp") {
      const { input, result } = response;
      const formula = `${result.goal === "max" ? "Max" : "Min"} Z = ${fmt(result.c1)}x ${result.c2 < 0 ? "−" : "+"} ${fmt(Math.abs(result.c2))}y`;
      if (result.status !== "optimal") {
        return `<p><strong>Programación lineal interpretada</strong></p><div class="chat-formula">${formula}</div><div class="chat-warning">${escapeHtml(result.message)}</div><button class="chat-module-button" data-chat-module="lineal" type="button">Abrir modelo completo</button>${suggestionMarkup(response)}`;
      }
      const best = result.optima[0];
      return `<p><strong>Programación lineal interpretada</strong></p><div class="chat-formula">${formula}<br>${input.constraints.map((c, index) => `R${index + 1}: ${constraintText(c)}`).join("<br>")}</div><div class="chat-result">Solución: x = ${fmt(best.x)}, y = ${fmt(best.y)} y Z = ${fmt(result.optimumValue)}.</div><ol><li>Calculé las intersecciones de las restricciones.</li><li>Descarté los puntos no factibles.</li><li>Sustituí cada vértice en la función objetivo.</li></ol><button class="chat-module-button" data-chat-module="lineal" type="button">Ver gráfico y simplex</button>${suggestionMarkup(response)}`;
    }
    if (response.type === "eoq") {
      const { input, result } = response;
      return `<p><strong>Inventario EOQ</strong></p><div class="chat-formula">Q* = √(2DS/H)<br>Q* = √(2 × ${fmt(input.demand)} × ${fmt(input.orderCost)} / ${fmt(input.holdingCost)})</div><div class="chat-result">Q* = ${fmt(result.eoq)} unidades; punto de reorden = ${fmt(result.reorderPoint)} unidades.</div><p>Esto equivale a ${fmt(result.orders)} pedidos al año, aproximadamente uno cada ${fmt(result.cycleDays)} días.</p><button class="chat-module-button" data-chat-module="inventarios" type="button">Abrir cálculo completo</button>${suggestionMarkup(response)}`;
    }
    if (response.type === "transport") {
      const { result } = response;
      const routes = [];
      result.allocation.forEach((row, i) => row.forEach((amount, j) => {
        if (amount > E.EPS) routes.push(`O${i + 1}→D${j + 1}: ${fmt(amount)}`);
      }));
      return `<p><strong>Transporte de costo mínimo</strong></p>${result.dummy ? `<div class="chat-warning">Se agregó ${result.dummy.type === "origin" ? "un origen" : "un destino"} ficticio de ${fmt(result.dummy.amount)} unidades para balancear.</div>` : ""}<div class="chat-result">Costo mínimo total = ${fmt(result.totalCost)}.</div><p>Plan: ${escapeHtml(routes.join("; "))}.</p><button class="chat-module-button" data-chat-module="transporte" type="button">Abrir matriz completa</button>${suggestionMarkup(response)}`;
    }
    if (response.type === "assignment") {
      const { result } = response;
      const pairs = result.assignments.filter((item) => !item.dummy).map((item) => `P${item.person + 1}→T${item.task + 1}`);
      return `<p><strong>Modelo de asignación</strong></p><div class="chat-result">Valor ${result.goal === "min" ? "mínimo" : "máximo"} = ${fmt(result.total)}.</div><p>Asignación: ${escapeHtml(pairs.join("; "))}.</p><button class="chat-module-button" data-chat-module="asignacion" type="button">Abrir tabla completa</button>${suggestionMarkup(response)}`;
    }
    return `<p>No pude generar una respuesta válida.</p>`;
  }

  function renderConversation() {
    const target = $("#chatMessages");
    target.innerHTML = state.conversation.map((item, index) => {
      const body = item.role === "user" ? `<p>${escapeHtml(item.text)}</p>` : answerMarkup(item.response);
      return `<article class="message ${item.role}"><span class="message-avatar">${item.role === "user" ? "TÚ" : "IO"}</span><div class="message-bubble">${body}</div></article>`;
    }).join("");
    $$(".chat-module-button", target).forEach((button) => button.addEventListener("click", () => {
      const article = button.closest(".message");
      const assistantMessages = $$(".message.assistant", target);
      const assistantIndex = assistantMessages.indexOf(article);
      const item = state.conversation.filter((entry) => entry.role === "assistant")[assistantIndex];
      openResponseModule(item?.response, button.dataset.chatModule);
    }));
    $$(".chat-quick", target).forEach((button) => button.addEventListener("click", () => submitQuestion(button.dataset.question)));
    target.scrollTop = target.scrollHeight;
  }

  function saveConversation() {
    try { localStorage.setItem("io-assistant-conversation", JSON.stringify(state.conversation.slice(-20))); } catch (_) { /* almacenamiento opcional */ }
  }

  function initialConversation() {
    return [{ role: "assistant", response: Q.answerQuestion("hola") }];
  }

  function loadConversation() {
    try {
      const saved = JSON.parse(localStorage.getItem("io-assistant-conversation") || "null");
      state.conversation = Array.isArray(saved) && saved.length ? saved : initialConversation();
    } catch (_) { state.conversation = initialConversation(); }
    state.chatContext = Q.rebuildContext(state.conversation);
    renderConversation();
  }

  function submitQuestion(text) {
    const clean = String(text).trim();
    if (!clean) {
      toast("Escribe una pregunta o un ejercicio.");
      return;
    }
    state.conversation.push({ role: "user", text: clean });
    state.conversation.push({ role: "assistant", response: Q.answerQuestion(clean, state.chatContext) });
    saveConversation();
    renderConversation();
  }

  function openResponseModule(response, moduleName) {
    if (!response) return;
    if (moduleName === "lineal" && response.input) {
      setLPInput(response.input);
      showView("lineal");
      $("#lpForm").requestSubmit();
    } else if (moduleName === "inventarios" && response.input) {
      $("#invDemand").value = response.input.demand;
      $("#invOrderCost").value = response.input.orderCost;
      $("#invHolding").value = response.input.holdingCost;
      $("#invDays").value = response.input.workingDays;
      $("#invLead").value = response.input.leadTime;
      $("#invSafety").value = response.input.safetyStock;
      showView("inventarios");
      $("#inventoryForm").requestSubmit();
    } else if (moduleName === "transporte" && response.input) {
      $("#transportCosts").value = response.input.costs.map((row) => row.join(" ")).join("\n");
      $("#transportSupply").value = response.input.supply.join(" ");
      $("#transportDemand").value = response.input.demand.join(" ");
      showView("transporte");
      $("#transportForm").requestSubmit();
    } else if (moduleName === "asignacion" && response.input) {
      $("#assignmentGoal").value = response.input.goal;
      $("#assignmentCosts").value = response.input.costs.map((row) => row.join(" ")).join("\n");
      showView("asignacion");
      $("#assignmentForm").requestSubmit();
    }
  }

  $("#questionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#questionInput");
    submitQuestion(input.value);
    input.value = "";
    input.focus();
  });
  $("#questionInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#questionForm").requestSubmit();
    }
  });
  $$(".question-example").forEach((button) => button.addEventListener("click", () => {
    $("#questionInput").value = button.dataset.question;
    $("#questionForm").requestSubmit();
  }));
  $("#clearConversation").addEventListener("click", () => {
    const hasMessages = state.conversation.some((item) => item.role === "user");
    if (!hasMessages) {
      toast("El chat ya está limpio.");
      return;
    }
    if (!window.confirm("¿Deseas borrar todos los mensajes y comenzar una conversación nueva?")) return;
    state.conversation = initialConversation();
    state.chatContext = Q.createContext();
    saveConversation();
    renderConversation();
    $("#questionInput").value = "";
    $("#questionInput").focus();
    toast("Chat limpiado. Puedes comenzar de nuevo.");
  });

  function loadIdentity() {
    try {
      const saved = JSON.parse(localStorage.getItem("io-assistant-identity") || "null");
      if (saved && typeof saved === "object") state.identity = { ...state.identity, ...saved };
    } catch (_) { /* almacenamiento opcional */ }
    $("#memberOne").value = state.identity.memberOne;
    $("#memberTwo").value = state.identity.memberTwo;
    $("#courseName").value = state.identity.course;
    $("#sectionName").value = state.identity.section;
    updateIdentityUI();
  }

  function updateIdentityUI() {
    const complete = state.identity.memberOne && state.identity.memberTwo;
    const sectionText = state.identity.section
      ? `; sección ${state.identity.section}.`
      : "; curso sin sección asignada.";
    $("#identitySummary").textContent = complete
      ? `${state.identity.memberOne} · ${state.identity.memberTwo}`
      : "Integrantes por completar";
    $("#identityCheckText").textContent = complete
      ? `${state.identity.memberOne} y ${state.identity.memberTwo}${sectionText}`
      : "Complete los nombres de ambos integrantes antes de entregar.";
    const icon = $("#identityStatusIcon");
    icon.textContent = complete ? "✓" : "!";
    icon.className = complete ? "ok" : "pending";
  }

  $("#openIdentity").addEventListener("click", () => $("#identityDialog").showModal());
  $("#identityForm").addEventListener("submit", (event) => {
    const submitter = event.submitter;
    if (submitter?.value === "cancel") return;
    state.identity = {
      memberOne: $("#memberOne").value.trim(),
      memberTwo: $("#memberTwo").value.trim(),
      course: $("#courseName").value.trim() || "Investigación de Operaciones",
      section: $("#sectionName").value.trim(),
    };
    localStorage.setItem("io-assistant-identity", JSON.stringify(state.identity));
    updateIdentityUI();
    toast("Identificación guardada en este navegador.");
  });

  function updateObjectivePreview() {
    const label = $("#lpGoal").value === "min" ? "Min" : "Max";
    const c1 = $("#lpC1").value || "?";
    const c2 = $("#lpC2").value || "?";
    $("#objectivePreview").textContent = `${label} Z = ${c1}x ${Number(c2) < 0 ? "−" : "+"} ${String(c2).replace("-", "")}y`;
  }
  ["#lpGoal", "#lpC1", "#lpC2"].forEach((selector) => $(selector).addEventListener("input", updateObjectivePreview));

  function renumberConstraints() {
    $$(".constraint-row", $("#constraintRows")).forEach((row, index) => {
      $(".constraint-number", row).textContent = `R${index + 1}`;
      $(".remove-constraint", row).disabled = $$(".constraint-row", $("#constraintRows")).length === 1;
    });
  }

  function addConstraint(values = {}) {
    const fragment = $("#constraintTemplate").content.cloneNode(true);
    const row = $(".constraint-row", fragment);
    $(".con-a", row).value = values.a ?? 1;
    $(".con-b", row).value = values.b ?? 1;
    $(".con-op", row).value = values.op ?? "<=";
    $(".con-rhs", row).value = values.rhs ?? 100;
    $(".remove-constraint", row).addEventListener("click", () => {
      row.remove();
      renumberConstraints();
    });
    $("#constraintRows").appendChild(fragment);
    renumberConstraints();
  }

  function setLPInput(input) {
    $("#lpGoal").value = input.goal;
    $("#lpC1").value = input.c1;
    $("#lpC2").value = input.c2;
    $("#constraintRows").innerHTML = "";
    input.constraints.forEach((constraint) => addConstraint(constraint));
    updateObjectivePreview();
  }

  function setLPExample() {
    setLPInput({
      goal: "max",
      c1: 40,
      c2: 30,
      constraints: [
        { a: 2, b: 1, op: "<=", rhs: 100 },
        { a: 1, b: 2, op: "<=", rhs: 80 },
      ],
    });
  }

  $("#addConstraint").addEventListener("click", () => addConstraint());
  $("#loadRubricExample").addEventListener("click", () => {
    setLPExample();
    $("#lpForm").requestSubmit();
    toast("Ejemplo de la rúbrica cargado y resuelto.");
  });

  function readLPForm() {
    const constraints = $$(".constraint-row", $("#constraintRows")).map((row) => ({
      a: $(".con-a", row).value,
      b: $(".con-b", row).value,
      op: $(".con-op", row).value,
      rhs: $(".con-rhs", row).value,
    }));
    return { goal: $("#lpGoal").value, c1: $("#lpC1").value, c2: $("#lpC2").value, constraints };
  }

  function constraintText(c) {
    return `${fmt(c.a)}x ${c.b < 0 ? "−" : "+"} ${fmt(Math.abs(c.b))}y ${c.op === "<=" ? "≤" : c.op === ">=" ? "≥" : "="} ${fmt(c.rhs)}`;
  }

  function renderLP(input, result) {
    const target = $("#lpResult");
    const model = `
      <div class="model-box">
        <p><strong>${result.goal === "max" ? "Maximizar" : "Minimizar"}</strong> Z = ${fmt(result.c1)}x ${result.c2 < 0 ? "−" : "+"} ${fmt(Math.abs(result.c2))}y</p>
        ${result.constraints.map((c, index) => `<p>R${index + 1}: ${constraintText(c)}</p>`).join("")}
        <p>x ≥ 0; y ≥ 0</p>
      </div>`;
    if (result.status !== "optimal") {
      target.innerHTML = `
        <div class="notice ${result.status === "infeasible" ? "error" : "warning"}"><strong>${result.status === "infeasible" ? "Modelo infactible" : "Modelo no acotado"}.</strong> ${escapeHtml(result.message)}</div>
        <h2>Modelo interpretado</h2>${model}
        <ol class="steps"><li><span>1</span><strong>Variables:</strong> x e y representan las cantidades de las dos decisiones.</li><li><span>2</span><strong>Diagnóstico:</strong> se evaluaron intersecciones y direcciones factibles antes de emitir la advertencia.</li></ol>`;
      return;
    }
    const primary = result.optima[0];
    target.innerHTML = `
      <div class="result-hero"><span class="result-label">Solución óptima</span><strong>x = ${fmt(primary.x)}, y = ${fmt(primary.y)}</strong><p>Z = ${fmt(result.optimumValue)} · ${escapeHtml(result.message)}</p></div>
      <h2>Modelo interpretado</h2>${model}
      <h2 style="margin-top:22px">Evaluación de vértices</h2>
      <table class="data-table"><thead><tr><th>Vértice</th><th>x</th><th>y</th><th>Z</th></tr></thead><tbody>
        ${result.vertices.map((point, index) => `<tr class="${result.optima.some((best) => Math.abs(best.x - point.x) < 1e-6 && Math.abs(best.y - point.y) < 1e-6) ? "highlight" : ""}"><td>V${index + 1}</td><td>${fmt(point.x)}</td><td>${fmt(point.y)}</td><td>${fmt(point.z)}</td></tr>`).join("")}
      </tbody></table>
      <ol class="steps">
        <li><span>1</span><strong>Variables de decisión.</strong> x e y son cantidades no negativas de las dos actividades.</li>
        <li><span>2</span><strong>Región factible.</strong> Se intersectan las rectas límite y se descartan puntos que incumplen alguna restricción.</li>
        <li><span>3</span><strong>Función objetivo.</strong> Se sustituye cada vértice en Z = ${fmt(result.c1)}x ${result.c2 < 0 ? "−" : "+"} ${fmt(Math.abs(result.c2))}y.</li>
        <li><span>4</span><strong>Respuesta.</strong> El mejor valor es Z = ${fmt(result.optimumValue)} en (${fmt(primary.x)}, ${fmt(primary.y)}).</li>
      </ol>
      <div class="notice success"><strong>Comprobación:</strong> el punto elegido satisface todas las restricciones y su valor de Z es ${result.goal === "max" ? "mayor o igual" : "menor o igual"} al de los demás vértices.</div>`;
  }

  function renderGraph(result) {
    const panel = $("#graphPanel");
    if (!result.vertices.length) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    const width = 760;
    const height = 460;
    const pad = { left: 66, right: 28, top: 24, bottom: 58 };
    const intercepts = result.constraints.flatMap((c) => [c.a ? c.rhs / c.a : 0, c.b ? c.rhs / c.b : 0]).filter((v) => Number.isFinite(v) && v > 0);
    const maxVertex = Math.max(1, ...result.vertices.flatMap((point) => [point.x, point.y]));
    const maxAxis = Math.max(maxVertex * 1.25, ...intercepts.map((v) => v * 1.08), 10);
    const maxX = maxAxis;
    const maxY = maxAxis;
    const sx = (x) => pad.left + (x / maxX) * (width - pad.left - pad.right);
    const sy = (y) => height - pad.bottom - (y / maxY) * (height - pad.top - pad.bottom);
    const ticks = 5;
    const grid = Array.from({ length: ticks + 1 }, (_, i) => {
      const x = (maxX / ticks) * i;
      const y = (maxY / ticks) * i;
      return `<line x1="${sx(x)}" y1="${pad.top}" x2="${sx(x)}" y2="${height - pad.bottom}" stroke="#e2e9ec"/><text x="${sx(x)}" y="${height - pad.bottom + 24}" text-anchor="middle">${fmt(x, 1)}</text>
        <line x1="${pad.left}" y1="${sy(y)}" x2="${width - pad.right}" y2="${sy(y)}" stroke="#e2e9ec"/><text x="${pad.left - 12}" y="${sy(y) + 4}" text-anchor="end">${fmt(y, 1)}</text>`;
    }).join("");
    const colors = ["#1d6fa5", "#d3773b", "#7b5ba7", "#2f8a6e", "#b34f6b", "#5d7181"];
    const lineSegments = result.constraints.map((c, index) => {
      const points = [];
      if (Math.abs(c.b) > E.EPS) {
        const y0 = c.rhs / c.b;
        const yX = (c.rhs - c.a * maxX) / c.b;
        if (y0 >= 0 && y0 <= maxY) points.push({ x: 0, y: y0 });
        if (yX >= 0 && yX <= maxY) points.push({ x: maxX, y: yX });
      }
      if (Math.abs(c.a) > E.EPS) {
        const x0 = c.rhs / c.a;
        const xY = (c.rhs - c.b * maxY) / c.a;
        if (x0 >= 0 && x0 <= maxX) points.push({ x: x0, y: 0 });
        if (xY >= 0 && xY <= maxX) points.push({ x: xY, y: maxY });
      }
      const unique = points.filter((point, i) => points.findIndex((other) => Math.hypot(point.x - other.x, point.y - other.y) < 1e-6) === i);
      if (unique.length < 2) return "";
      return `<line x1="${sx(unique[0].x)}" y1="${sy(unique[0].y)}" x2="${sx(unique[1].x)}" y2="${sy(unique[1].y)}" stroke="${colors[index % colors.length]}" stroke-width="2.4"/><text x="${sx(unique[1].x) - 4}" y="${sy(unique[1].y) - 7}" fill="${colors[index % colors.length]}" text-anchor="end">R${index + 1}</text>`;
    }).join("");
    const centroid = result.vertices.reduce((sum, point) => ({ x: sum.x + point.x / result.vertices.length, y: sum.y + point.y / result.vertices.length }), { x: 0, y: 0 });
    const polygon = [...result.vertices].sort((a, b) => Math.atan2(a.y - centroid.y, a.x - centroid.x) - Math.atan2(b.y - centroid.y, b.x - centroid.x));
    const polygonSvg = result.status === "unbounded" ? "" : `<polygon points="${polygon.map((point) => `${sx(point.x)},${sy(point.y)}`).join(" ")}" fill="rgba(56,183,180,.22)" stroke="#38a9a6" stroke-width="2"/>`;
    const verticesSvg = result.vertices.map((point) => {
      const optimum = result.optima?.some((best) => Math.abs(best.x - point.x) < 1e-6 && Math.abs(best.y - point.y) < 1e-6);
      return `<circle cx="${sx(point.x)}" cy="${sy(point.y)}" r="${optimum ? 7 : 4.5}" fill="${optimum ? "#dc6b35" : "#102f50"}" stroke="white" stroke-width="2"><title>(${fmt(point.x)}, ${fmt(point.y)}) Z=${fmt(point.z)}</title></circle>`;
    }).join("");
    $("#lpGraph").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico de restricciones y región factible">
      <rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="#fbfcfc"/>
      <g font-family="Inter, sans-serif" font-size="11" fill="#6c7c88">${grid}</g>
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#102f50" stroke-width="2"/>
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${pad.left}" y2="${pad.top}" stroke="#102f50" stroke-width="2"/>
      <text x="${width - pad.right}" y="${height - 16}" text-anchor="end" fill="#102f50" font-weight="700">x</text>
      <text x="25" y="${pad.top}" fill="#102f50" font-weight="700">y</text>
      ${polygonSvg}${lineSegments}${verticesSvg}
    </svg>`;
  }

  function renderSimplex(input, lpResult) {
    const panel = $("#simplexPanel");
    const compatible = input.goal === "max" && input.constraints.every((c) => c.op === "<=" && Number(c.rhs) >= 0);
    if (!compatible) {
      panel.classList.remove("hidden");
      $("#simplexResult").innerHTML = `<div class="notice warning">El tableau básico se muestra solo para maximización con restricciones ≤ y RHS no negativo. El método gráfico anterior sí resolvió este modelo.</div>`;
      return;
    }
    try {
      const simplex = E.solveSimplex({
        c: [input.c1, input.c2],
        A: input.constraints.map((c) => [c.a, c.b]),
        b: input.constraints.map((c) => c.rhs),
      });
      panel.classList.remove("hidden");
      if (simplex.status !== "optimal") {
        $("#simplexResult").innerHTML = `<div class="notice warning">El método simplex detectó un modelo ${simplex.status === "unbounded" ? "no acotado" : "sin convergencia dentro del límite"}.</div>`;
        return;
      }
      const headers = simplex.variableNames;
      $("#simplexResult").innerHTML = `
        <div class="notice success"><strong>Coincidencia de métodos:</strong> simplex obtiene x = ${fmt(simplex.values[0])}, y = ${fmt(simplex.values[1])} y Z = ${fmt(simplex.optimumValue)}${lpResult.status === "optimal" && Math.abs(simplex.optimumValue - lpResult.optimumValue) < 1e-6 ? "; coincide con el método gráfico." : "."}</div>
        <p>Se agregan variables de holgura. En cada iteración entra la variable con coeficiente más negativo en la fila Z y sale la de menor razón positiva.</p>
        <div class="simplex-iterations">${simplex.iterations.map((iteration, index) => `
          <details ${index === simplex.iterations.length - 1 ? "open" : ""}><summary>Iteración ${index}: ${escapeHtml(iteration.note)}</summary><div class="table-scroll"><table class="data-table"><thead><tr><th>Base</th>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${iteration.tableau.map((row, rowIndex) => `<tr><td>${rowIndex < iteration.basis.length ? iteration.basis[rowIndex] : "Z"}</td>${row.map((value) => `<td>${fmt(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`).join("")}</div>`;
    } catch (error) {
      panel.classList.remove("hidden");
      $("#simplexResult").innerHTML = errorNotice(error);
    }
  }

  $("#lpForm").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const input = readLPForm();
      const result = E.solveLinearProgram(input);
      renderLP(input, result);
      renderGraph(result);
      renderSimplex(input, result);
    } catch (error) {
      $("#lpResult").innerHTML = errorNotice(error);
      $("#graphPanel").classList.add("hidden");
      $("#simplexPanel").classList.add("hidden");
    }
  });

  function errorNotice(error) {
    return `<div class="notice error"><strong>No se pudo calcular.</strong> ${escapeHtml(error?.message || "Revisa los datos ingresados.")}</div>`;
  }

  $("#loadTransportExample").addEventListener("click", () => {
    $("#transportCosts").value = "8 6 10\n9 12 13\n14 9 16";
    $("#transportSupply").value = "35 50 40";
    $("#transportDemand").value = "45 20 60";
    $("#transportForm").requestSubmit();
  });

  $("#transportForm").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const result = E.solveTransportation({
        costs: E.parseMatrix($("#transportCosts").value),
        supply: E.parseVector($("#transportSupply").value, "Oferta"),
        demand: E.parseVector($("#transportDemand").value, "Demanda"),
      });
      const routes = [];
      result.allocation.forEach((row, i) => row.forEach((amount, j) => {
        if (amount > E.EPS) routes.push(`O${i + 1} → D${j + 1}: ${fmt(amount)} × ${fmt(result.costs[i][j])} = ${fmt(amount * result.costs[i][j])}`);
      }));
      $("#transportResult").innerHTML = `
        <div class="result-hero"><span class="result-label">Costo mínimo</span><strong>${fmt(result.totalCost)}</strong><p>Se satisface toda la demanda respetando la oferta disponible.</p></div>
        ${result.dummy ? `<div class="notice warning">El problema no estaba balanceado. Se agregó ${result.dummy.type === "origin" ? "un origen" : "un destino"} ficticio de ${fmt(result.dummy.amount)} unidades con costo cero.</div>` : `<div class="notice success">Oferta total y demanda total están balanceadas.</div>`}
        <h2>Matriz de envíos óptimos</h2>
        <div class="matrix-wrap"><table class="data-table"><thead><tr><th>Origen</th>${result.demand.map((_, j) => `<th>D${j + 1}</th>`).join("")}<th>Oferta</th></tr></thead><tbody>${result.allocation.map((row, i) => `<tr><th>O${i + 1}</th>${row.map((value) => `<td class="${value > E.EPS ? "allocation-positive" : ""}">${fmt(value)}</td>`).join("")}<td>${fmt(result.supply[i])}</td></tr>`).join("")}<tr><th>Demanda</th>${result.demand.map((value) => `<td>${fmt(value)}</td>`).join("")}<td></td></tr></tbody></table></div>
        <ol class="steps"><li><span>1</span><strong>Balance.</strong> Se compara oferta total con demanda total.</li><li><span>2</span><strong>Optimización.</strong> Se envía flujo por las rutas de menor costo marginal, permitiendo correcciones mediante rutas residuales.</li><li><span>3</span><strong>Sustitución.</strong> ${routes.map(escapeHtml).join("; ")}.</li><li><span>4</span><strong>Respuesta.</strong> La suma de costo por cantidad es ${fmt(result.totalCost)}.</li></ol>`;
    } catch (error) {
      $("#transportResult").innerHTML = errorNotice(error);
    }
  });

  $("#loadAssignmentExample").addEventListener("click", () => {
    $("#assignmentGoal").value = "min";
    $("#assignmentCosts").value = "9 2 7 8\n6 4 3 7\n5 8 1 8\n7 6 9 4";
    $("#assignmentForm").requestSubmit();
  });

  $("#assignmentForm").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const matrix = E.parseMatrix($("#assignmentCosts").value);
      const result = E.solveAssignment({ costs: matrix, goal: $("#assignmentGoal").value });
      const assigned = result.assignments.filter((item) => !item.dummy);
      $("#assignmentResult").innerHTML = `
        <div class="result-hero"><span class="result-label">${result.goal === "min" ? "Valor mínimo" : "Valor máximo"}</span><strong>${fmt(result.total)}</strong><p>${assigned.length} asignaciones seleccionadas sin repetir tareas.</p></div>
        ${result.padded ? `<div class="notice warning">La matriz no era cuadrada; se agregó una fila o columna ficticia de valor cero.</div>` : ""}
        <table class="data-table"><thead><tr><th>Persona o recurso</th><th>Tarea</th><th>Valor</th></tr></thead><tbody>${result.assignments.map((item) => `<tr><td>P${item.person + 1}</td><td>${item.dummy ? "Sin tarea (ficticia)" : `T${item.task + 1}`}</td><td>${fmt(item.value)}</td></tr>`).join("")}</tbody></table>
        <ol class="steps"><li><span>1</span><strong>Condición.</strong> Cada fila elige una columna y ninguna tarea se repite.</li><li><span>2</span><strong>Comparación.</strong> Se evalúan combinaciones posibles mediante programación dinámica.</li><li><span>3</span><strong>Respuesta.</strong> ${assigned.map((item) => `P${item.person + 1}→T${item.task + 1} (${fmt(item.value)})`).join(" + ")} = ${fmt(result.total)}.</li></ol>
        <div class="notice success"><strong>Comprobación:</strong> no hay personas ni tareas repetidas en la asignación seleccionada.</div>`;
    } catch (error) {
      $("#assignmentResult").innerHTML = errorNotice(error);
    }
  });

  $("#loadInventoryExample").addEventListener("click", () => {
    $("#invDemand").value = 12000;
    $("#invOrderCost").value = 50;
    $("#invHolding").value = 2;
    $("#invDays").value = 360;
    $("#invLead").value = 5;
    $("#invSafety").value = 20;
    $("#inventoryForm").requestSubmit();
  });

  $("#inventoryForm").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const input = {
        demand: $("#invDemand").value,
        orderCost: $("#invOrderCost").value,
        holdingCost: $("#invHolding").value,
        workingDays: $("#invDays").value,
        leadTime: $("#invLead").value,
        safetyStock: $("#invSafety").value,
      };
      const result = E.calculateEOQ(input);
      $("#inventoryResult").innerHTML = `
        <div class="result-hero"><span class="result-label">Cantidad económica de pedido</span><strong>Q* = ${fmt(result.eoq)} unidades</strong><p>Pedir nuevamente cuando la posición de inventario llegue a ${fmt(result.reorderPoint)} unidades.</p></div>
        <div class="summary-cards"><div class="summary-card"><span>Pedidos al año</span><strong>${fmt(result.orders)}</strong></div><div class="summary-card"><span>Días entre pedidos</span><strong>${fmt(result.cycleDays)}</strong></div><div class="summary-card"><span>Costo de ordenar</span><strong>${fmt(result.orderingCost)}</strong></div><div class="summary-card"><span>Costo de mantener</span><strong>${fmt(result.holdingCost)}</strong></div></div>
        <ol class="steps"><li><span>1</span><strong>Fórmula EOQ.</strong> Q* = √(2DS/H).</li><li><span>2</span><strong>Sustitución.</strong> Q* = √(2 × ${fmt(input.demand)} × ${fmt(input.orderCost)} / ${fmt(input.holdingCost)}) = ${fmt(result.eoq)}.</li><li><span>3</span><strong>Demanda diaria.</strong> d = D/días = ${fmt(result.dailyDemand)} unidades por día.</li><li><span>4</span><strong>Punto de reorden.</strong> R = dL + SS = ${fmt(result.dailyDemand)} × ${fmt(input.leadTime)} + ${fmt(input.safetyStock)} = ${fmt(result.reorderPoint)}.</li><li><span>5</span><strong>Interpretación.</strong> Ordenar aproximadamente ${fmt(result.eoq)} unidades cada ${fmt(result.cycleDays)} días.</li></ol>
        <div class="notice success"><strong>Comprobación EOQ:</strong> en Q*, el costo anual de ordenar (${fmt(result.orderingCost)}) coincide con el costo anual de mantener (${fmt(result.holdingCost)}), salvo redondeo.</div>`;
    } catch (error) {
      $("#inventoryResult").innerHTML = errorNotice(error);
    }
  });

  const practiceExercises = [
    {
      module: "Programación lineal", level: "Básico", title: "Ejercicio de evaluación",
      problem: "Maximiza Z = 40x + 30y, sujeto a 2x + y ≤ 100, x + 2y ≤ 80, x,y ≥ 0. ¿Cuál es el valor óptimo de Z?",
      hint: "Intersecta las dos restricciones activas y evalúa Z en todos los vértices.",
      solve: () => ({ answer: 2200, explanation: "Las rectas se intersectan en (40,20). Z = 40(40) + 30(20) = 2200, mayor que en (50,0) y (0,40)." }),
    },
    {
      module: "Programación lineal", level: "Básico", title: "Coordenada óptima",
      problem: "Maximiza Z = 3x + 5y, sujeto a x ≤ 4, 2y ≤ 12, 3x + 2y ≤ 18, x,y ≥ 0. ¿Cuál es el valor óptimo de y?",
      hint: "Compara los vértices (0,0), (4,0), (4,3), (2,6) y (0,6).",
      solve: () => ({ answer: 6, explanation: "En (2,6), Z = 36 y es el máximo. Por tanto, y = 6." }),
    },
    {
      module: "Simplex", level: "Intermedio", title: "Holgura final",
      problem: "En el ejemplo de evaluación, ¿cuál es la holgura de 2x + y ≤ 100 en la solución x = 40, y = 20?",
      hint: "Holgura = RHS − lado izquierdo.",
      solve: () => ({ answer: 0, explanation: "100 − [2(40) + 20] = 0. La restricción está activa." }),
    },
    {
      module: "Transporte", level: "Intermedio", title: "Costo de distribución",
      problem: "Costos [[8,6,10],[9,12,13],[14,9,16]], oferta [35,50,40] y demanda [45,20,60]. ¿Cuál es el costo mínimo?",
      hint: "El modelo está balanceado: oferta y demanda suman 125.",
      solve: () => {
        const r = E.solveTransportation({ costs: [[8,6,10],[9,12,13],[14,9,16]], supply: [35,50,40], demand: [45,20,60] });
        return { answer: r.totalCost, explanation: `El plan óptimo encontrado por flujo de costo mínimo suma ${fmt(r.totalCost)}.` };
      },
    },
    {
      module: "Transporte", level: "Básico", title: "Balance del modelo",
      problem: "La oferta total es 150 y la demanda total es 135. ¿Cuántas unidades debe tener el destino ficticio?",
      hint: "El destino ficticio absorbe el excedente de oferta.",
      solve: () => ({ answer: 15, explanation: "150 − 135 = 15 unidades de excedente; se agrega un destino ficticio con demanda 15." }),
    },
    {
      module: "Asignación", level: "Intermedio", title: "Asignación de costo mínimo",
      problem: "Para la matriz [[9,2,7,8],[6,4,3,7],[5,8,1,8],[7,6,9,4]], ¿cuál es el costo total mínimo?",
      hint: "Una combinación óptima es P1→T2, P2→T1, P3→T3 y P4→T4.",
      solve: () => ({ answer: 13, explanation: "2 + 6 + 1 + 4 = 13, sin repetir ninguna tarea." }),
    },
    {
      module: "Asignación", level: "Intermedio", title: "Asignación de beneficio máximo",
      problem: "Maximiza la matriz [[8,6,7],[5,9,6],[7,8,10]]. ¿Cuál es el beneficio total máximo?",
      hint: "Evalúa una tarea distinta para cada persona.",
      solve: () => {
        const r = E.solveAssignment({ costs: [[8,6,7],[5,9,6],[7,8,10]], goal: "max" });
        return { answer: r.total, explanation: "P1→T1 (8), P2→T2 (9) y P3→T3 (10): total 27." };
      },
    },
    {
      module: "Inventarios", level: "Básico", title: "Cantidad económica",
      problem: "D = 10,000 unidades/año, S = 40 y H = 2. ¿Cuál es el EOQ aproximado?",
      hint: "Usa Q* = √(2DS/H).",
      tolerance: 0.6,
      solve: () => ({ answer: 632.46, explanation: "Q* = √[2(10,000)(40)/2] = √400,000 = 632.46 unidades." }),
    },
    {
      module: "Inventarios", level: "Básico", title: "Punto de reorden",
      problem: "D = 7,200, 360 días/año, tiempo de entrega 5 días e inventario de seguridad 20. ¿Cuál es el punto de reorden?",
      hint: "Primero calcula d = D/360; después R = dL + SS.",
      solve: () => ({ answer: 120, explanation: "d = 7,200/360 = 20. R = 20(5) + 20 = 120 unidades." }),
    },
    {
      module: "Inventarios", level: "Intermedio", title: "Número de pedidos",
      problem: "D = 5,000, S = 25 y H = 1. ¿Cuántos pedidos por año recomienda EOQ?",
      hint: "Calcula Q* y luego N = D/Q*.",
      solve: () => ({ answer: 10, explanation: "Q* = √[2(5,000)(25)] = 500. N = 5,000/500 = 10 pedidos al año." }),
    },
  ];

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function createGeneratedPractice() {
    const variant = randomInt(0, 4);
    if (variant === 0) {
      const xCap = randomInt(4, 10);
      const yCap = randomInt(4, 10);
      const shared = randomInt(Math.max(xCap, yCap), xCap + yCap - 1);
      const c1 = randomInt(2, 9);
      const c2 = randomInt(2, 9);
      const model = { goal: "max", c1, c2, constraints: [{ a: 1, b: 0, op: "<=", rhs: xCap }, { a: 0, b: 1, op: "<=", rhs: yCap }, { a: 1, b: 1, op: "<=", rhs: shared }] };
      const result = E.solveLinearProgram(model);
      const best = result.optima[0];
      return {
        generated: true, module: "Programación lineal", level: "Generado", title: "Nueva optimización",
        problem: `Maximiza Z = ${c1}x + ${c2}y, sujeto a x ≤ ${xCap}, y ≤ ${yCap}, x + y ≤ ${shared}, x,y ≥ 0. ¿Cuál es el valor óptimo de Z?`,
        hint: "Encuentra los vértices de la región factible y evalúa la función objetivo en cada uno.",
        solve: () => ({ answer: result.optimumValue, explanation: `El mejor vértice es (${fmt(best.x)}, ${fmt(best.y)}). Z = ${c1}(${fmt(best.x)}) + ${c2}(${fmt(best.y)}) = ${fmt(result.optimumValue)}.` }),
      };
    }
    if (variant === 1) {
      const demand = randomInt(4, 20) * 1000;
      const orderCost = randomInt(4, 12) * 5;
      const holdingCost = randomInt(1, 8);
      const result = E.calculateEOQ({ demand, orderCost, holdingCost, workingDays: 360, leadTime: 0, safetyStock: 0 });
      return {
        generated: true, module: "Inventarios", level: "Generado", title: "Nuevo cálculo EOQ", tolerance: 0.6,
        problem: `Una empresa tiene D = ${demand} unidades/año, S = ${orderCost} por pedido y H = ${holdingCost} por unidad/año. ¿Cuál es el EOQ aproximado?`,
        hint: "Usa Q* = √(2DS/H) y redondea a dos decimales.",
        solve: () => ({ answer: result.eoq, explanation: `Q* = √[2(${demand})(${orderCost})/${holdingCost}] = ${fmt(result.eoq)} unidades.` }),
      };
    }
    if (variant === 2) {
      const workingDays = randomInt(0, 1) ? 360 : 300;
      const dailyDemand = randomInt(10, 40);
      const demand = dailyDemand * workingDays;
      const leadTime = randomInt(2, 8);
      const safetyStock = randomInt(0, 10) * 5;
      const answer = dailyDemand * leadTime + safetyStock;
      return {
        generated: true, module: "Inventarios", level: "Generado", title: "Nuevo punto de reorden",
        problem: `D = ${demand}, ${workingDays} días/año, entrega en ${leadTime} días e inventario de seguridad ${safetyStock}. ¿Cuál es el punto de reorden?`,
        hint: "Calcula d = D/días y después aplica R = dL + SS.",
        solve: () => ({ answer, explanation: `d = ${demand}/${workingDays} = ${dailyDemand}. R = ${dailyDemand}(${leadTime}) + ${safetyStock} = ${answer} unidades.` }),
      };
    }
    if (variant === 3) {
      const supply = [randomInt(30, 70), randomInt(30, 70)];
      const totalSupply = supply[0] + supply[1];
      const excess = randomInt(5, 20);
      const firstDemand = randomInt(20, totalSupply - excess - 20);
      const demand = [firstDemand, totalSupply - excess - firstDemand];
      return {
        generated: true, module: "Transporte", level: "Generado", title: "Nuevo balance de transporte",
        problem: `La oferta es [${supply.join(", ")}] y la demanda es [${demand.join(", ")}]. ¿Cuántas unidades debe absorber el destino ficticio?`,
        hint: "Suma la oferta y la demanda. El destino ficticio recibe el excedente de oferta.",
        solve: () => ({ answer: excess, explanation: `Oferta total = ${totalSupply}; demanda total = ${totalSupply - excess}. El excedente es ${totalSupply} - ${totalSupply - excess} = ${excess}.` }),
      };
    }
    const costs = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => randomInt(1, 9)));
    const result = E.solveAssignment({ costs, goal: "min" });
    const pairs = result.assignments.filter((item) => !item.dummy).map((item) => `P${item.person + 1}→T${item.task + 1} (${item.value})`).join(", ");
    return {
      generated: true, module: "Asignación", level: "Generado", title: "Nueva asignación mínima",
      problem: `Para la matriz [[${costs.map((row) => row.join(",")).join("],[")}]], ¿cuál es el costo total mínimo?`,
      hint: "Selecciona una tarea distinta para cada persona y compara los costos totales.",
      solve: () => ({ answer: result.total, explanation: `${pairs}. El costo mínimo total es ${fmt(result.total)}.` }),
    };
  }

  function generatePractice() {
    state.practice.generated = createGeneratedPractice();
    state.practice.current = practiceExercises.length;
    renderExerciseIndex();
    renderExercise();
    toast("Nueva práctica generada con datos diferentes.");
  }

  function loadPracticeState() {
    try {
      const saved = JSON.parse(localStorage.getItem("io-assistant-practice") || "null");
      if (saved && Array.isArray(saved.correct)) state.practice.correct = saved.correct;
    } catch (_) { /* progreso opcional */ }
    renderExerciseIndex();
    renderExercise();
  }

  function renderExerciseIndex() {
    const exercises = state.practice.generated ? [...practiceExercises, state.practice.generated] : practiceExercises;
    $("#exerciseIndex").innerHTML = exercises.map((exercise, index) => `<button class="exercise-tab ${index === state.practice.current ? "active" : ""} ${state.practice.correct.includes(index) ? "correct" : ""} ${exercise.generated ? "generated" : ""}" data-index="${index}" type="button"><span>${exercise.generated ? "N" : state.practice.correct.includes(index) ? "✓" : index + 1}</span><div>${escapeHtml(exercise.module)}<small>${exercise.generated ? "Nueva práctica" : escapeHtml(exercise.level)}</small></div></button>`).join("");
    $$(".exercise-tab", $("#exerciseIndex")).forEach((button) => button.addEventListener("click", () => {
      state.practice.current = Number(button.dataset.index);
      renderExerciseIndex();
      renderExercise();
    }));
    $("#practiceScore").textContent = `${state.practice.correct.length} / ${practiceExercises.length}`;
  }

  function renderExercise() {
    const exercise = state.practice.current === practiceExercises.length ? state.practice.generated : practiceExercises[state.practice.current];
    if (!exercise) {
      state.practice.current = 0;
      return renderExercise();
    }
    const exerciseLabel = exercise.generated ? "Práctica nueva generada" : `Ejercicio ${state.practice.current + 1} de ${practiceExercises.length}`;
    $("#exerciseCard").innerHTML = `
      <div class="exercise-meta"><span class="tag">${escapeHtml(exercise.module)}</span><span class="difficulty">${escapeHtml(exercise.level)} · ${exerciseLabel}</span></div>
      <h2>${escapeHtml(exercise.title)}</h2><div class="problem">${escapeHtml(exercise.problem)}</div>
      <div class="answer-row"><label><span class="sr-only">Tu respuesta numérica</span><input id="practiceAnswer" type="number" step="any" placeholder="Escribe solamente el valor numérico"></label><button class="primary" id="checkAnswer" type="button">Comprobar</button></div>
      <div class="feedback" id="practiceFeedback"></div>
      <div class="exercise-actions"><button class="secondary" id="showHint" type="button">Mostrar pista</button><button class="secondary" id="showSolution" type="button">Ver solución explicada</button>${state.practice.current < practiceExercises.length - 1 ? `<button class="text-button" id="nextExercise" type="button">Siguiente →</button>` : ""}${exercise.generated ? `<button class="text-button" id="generateAnother" type="button">Generar otra →</button>` : ""}</div>
      <div id="practiceHelp"></div>`;
    $("#checkAnswer").addEventListener("click", checkPracticeAnswer);
    $("#practiceAnswer").addEventListener("keydown", (event) => { if (event.key === "Enter") checkPracticeAnswer(); });
    $("#showHint").addEventListener("click", () => { $("#practiceHelp").innerHTML = `<div class="solution-box"><strong>Pista:</strong> ${escapeHtml(exercise.hint)}</div>`; });
    $("#showSolution").addEventListener("click", () => {
      const solved = exercise.solve();
      $("#practiceHelp").innerHTML = `<div class="solution-box"><strong>Solución:</strong> ${escapeHtml(solved.explanation)} <strong>Respuesta: ${fmt(solved.answer)}</strong>.</div>`;
    });
    $("#nextExercise")?.addEventListener("click", () => {
      state.practice.current += 1;
      renderExerciseIndex();
      renderExercise();
    });
    $("#generateAnother")?.addEventListener("click", generatePractice);
  }

  function checkPracticeAnswer() {
    const exercise = state.practice.current === practiceExercises.length ? state.practice.generated : practiceExercises[state.practice.current];
    const raw = $("#practiceAnswer").value;
    if (raw === "" || !Number.isFinite(Number(raw))) {
      $("#practiceFeedback").innerHTML = `<div class="notice warning">Escribe un valor numérico antes de comprobar.</div>`;
      return;
    }
    const solved = exercise.solve();
    const correct = Math.abs(Number(raw) - solved.answer) <= (exercise.tolerance ?? 1e-4);
    if (correct) {
      if (!exercise.generated && !state.practice.correct.includes(state.practice.current)) state.practice.correct.push(state.practice.current);
      if (!exercise.generated) localStorage.setItem("io-assistant-practice", JSON.stringify({ correct: state.practice.correct }));
      $("#practiceFeedback").innerHTML = `<div class="notice success"><strong>Correcto.</strong> ${escapeHtml(solved.explanation)}</div>`;
      renderExerciseIndex();
    } else {
      $("#practiceFeedback").innerHTML = `<div class="notice error"><strong>Aún no.</strong> Revisa unidades, operaciones y redondeo. Usa la pista o intenta otra vez.</div>`;
    }
  }

  $("#generatePractice").addEventListener("click", generatePractice);

  $("#runSelfCheck").addEventListener("click", () => {
    const checks = [];
    try {
      const lp = E.solveLinearProgram({ goal: "max", c1: 40, c2: 30, constraints: [{a:2,b:1,op:"<=",rhs:100},{a:1,b:2,op:"<=",rhs:80}] });
      checks.push(lp.status === "optimal" && Math.abs(lp.optimumValue - 2200) < 1e-6);
      const tr = E.solveTransportation({ costs: [[8,6,10],[9,12,13],[14,9,16]], supply: [35,50,40], demand: [45,20,60] });
      checks.push(tr.status === "optimal" && tr.totalCost > 0);
      const as = E.solveAssignment({ costs: [[9,2,7,8],[6,4,3,7],[5,8,1,8],[7,6,9,4]], goal: "min" });
      checks.push(as.total === 13);
      const inv = E.calculateEOQ({ demand: 5000, orderCost: 25, holdingCost: 1, workingDays: 360, leadTime: 5, safetyStock: 0 });
      checks.push(Math.abs(inv.eoq - 500) < 1e-6);
      const question = Q.answerQuestion("Maximiza Z = 40x + 30y, sujeto a 2x + y <= 100; x + 2y <= 80");
      const context = Q.createContext();
      const arithmetic = Q.answerQuestion("cuanto es 5*20 y damelo con procedimiento", context);
      const followUp = Q.answerQuestion("y dividido entre 4", context);
      checks.push(question.type === "lp" && Math.abs(question.result.optimumValue - 2200) < 1e-6 && arithmetic.value === 100 && arithmetic.steps.length >= 3 && followUp.value === 25);
    } catch (_) { checks.push(false); }
    const passed = checks.filter(Boolean).length;
    $("#selfCheckResult").innerHTML = passed === checks.length
      ? `<div class="notice success"><strong>${passed}/${checks.length} comprobaciones superadas.</strong> Los motores principales responden con los resultados esperados.</div>`
      : `<div class="notice error"><strong>${passed}/${checks.length} comprobaciones superadas.</strong> Recarga la página; si persiste, no uses esta copia para entregar.</div>`;
  });

  setLPExample();
  loadIdentity();
  loadPracticeState();
  loadConversation();
})();
