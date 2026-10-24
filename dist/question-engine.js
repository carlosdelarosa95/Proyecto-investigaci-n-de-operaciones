(function (root, factory) {
  let engine = root.IOEngine;
  if (typeof module === "object" && module.exports) engine = require("./solver.js");
  const api = factory(engine);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.IOQuestionEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (E) {
  "use strict";

  function plain(text) {
    return String(text)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[¿?¡!]/g, "")
      .trim();
  }

  function scalar(value) {
    return Number(String(value).replace(",", "."));
  }

  function coefficient(value) {
    const clean = String(value ?? "").replace(/\s/g, "");
    if (!clean || clean === "+") return 1;
    if (clean === "-") return -1;
    return scalar(clean);
  }

  function operator(value) {
    if (value === "≤") return "<=";
    if (value === "≥") return ">=";
    return value;
  }

  function createContext() {
    return {
      turns: 0,
      lastInput: "",
      lastResponse: null,
      lastSubjectResponse: null,
      lastTopic: "",
      lastNumericResult: null,
      pending: null,
    };
  }

  function remember(context, input, response) {
    if (!context || typeof context !== "object") return response;
    context.turns = Number(context.turns || 0) + 1;
    context.lastInput = String(input);
    context.lastResponse = response;
    if (!["conversation", "clarification", "error"].includes(response.type)) {
      context.lastSubjectResponse = response;
      context.lastTopic = response.title || response.type;
    }
    if (Number.isFinite(response.value)) context.lastNumericResult = response.value;
    if (response.pending) context.pending = response.pending;
    if (response.resolvedPending) context.pending = null;
    return response;
  }

  function tidy(value) {
    if (!Number.isFinite(value)) throw new Error("El resultado no es un número finito.");
    const rounded = Math.round((value + Number.EPSILON) * 1e10) / 1e10;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function tokenizeExpression(expression) {
    const source = String(expression).replace(/\s+/g, "");
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      const number = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (number) {
        tokens.push({ type: "number", value: Number(number[0]) });
        index += number[0].length;
        continue;
      }
      const character = source[index];
      if ("+-*/^()".includes(character)) {
        tokens.push({ type: character, value: character });
        index += 1;
        continue;
      }
      throw new Error(`No reconozco "${character}" dentro de la operación.`);
    }
    return tokens;
  }

  function evaluateExpression(expression) {
    const tokens = tokenizeExpression(expression);
    let position = 0;
    const peek = () => tokens[position];
    const take = (type) => {
      const token = tokens[position];
      if (!token || token.type !== type) throw new Error("La operación está incompleta o tiene paréntesis incorrectos.");
      position += 1;
      return token;
    };
    const primary = () => {
      if (peek()?.type === "number") return take("number").value;
      if (peek()?.type === "(") {
        take("(");
        const value = expressionRule();
        take(")");
        return value;
      }
      throw new Error("Falta un número en la operación.");
    };
    const unary = () => {
      if (peek()?.type === "+") { take("+"); return unary(); }
      if (peek()?.type === "-") { take("-"); return -unary(); }
      return primary();
    };
    const power = () => {
      const base = unary();
      if (peek()?.type !== "^") return base;
      take("^");
      const exponent = power();
      if (Math.abs(exponent) > 100) throw new Error("El exponente es demasiado grande para esta calculadora.");
      return Math.pow(base, exponent);
    };
    const term = () => {
      let value = power();
      while (peek() && (peek().type === "*" || peek().type === "/")) {
        const operation = take(peek().type).type;
        const next = power();
        if (operation === "/" && Math.abs(next) < 1e-15) throw new Error("No se puede dividir entre cero.");
        value = operation === "*" ? value * next : value / next;
      }
      return value;
    };
    const expressionRule = () => {
      let value = term();
      while (peek() && (peek().type === "+" || peek().type === "-")) {
        const operation = take(peek().type).type;
        const next = term();
        value = operation === "+" ? value + next : value - next;
      }
      return value;
    };
    if (!tokens.length) throw new Error("Escribe los números de la operación.");
    const result = expressionRule();
    if (position !== tokens.length) throw new Error("Hay símbolos adicionales que no pude interpretar.");
    return tidy(result);
  }

  function expressionFromText(input) {
    let text = plain(input)
      .replace(/^(?:cual\s+es\s+el\s+resultado\s+de|cuanto\s+(?:es|da)|calcula(?:r)?|resuelve|resultado\s+de|dime\s+cuanto\s+es|haz|multiplica)\s*/i, "")
      .replace(/elevado\s+a(?:\s+la)?/g, "^")
      .replace(/dividido\s+entre|dividido\s+por/g, "/")
      .replace(/multiplicado\s+por/g, "*")
      .replace(/mas/g, "+")
      .replace(/menos/g, "-")
      .replace(/entre/g, "/")
      .replace(/por/g, "*")
      .replace(/[×·]/g, "*")
      .replace(/(\d|\))\s*x\s*(?=\d|\()/g, "$1*")
      .replace(/,/g, ".")
      .replace(/(\d|\))\s*(?=\()/g, "$1*")
      .replace(/\)\s*(?=\d)/g, ")*")
      .replace(/[.;:]$/g, "")
      .trim();
    if (!text) return null;
    if (!/[^\d.\s+\-*/^()]/.test(text)) return text;
    const candidates = (text.match(/[\d.\s+\-*/^()]+/g) || [])
      .map((candidate) => candidate.trim().replace(/[.;:]$/g, ""))
      .filter((candidate) => /\d/.test(candidate) && /[+\-*/^]/.test(candidate))
      .sort((a, b) => b.length - a.length);
    return candidates[0] || null;
  }

  function wantsProcedure(input) {
    return /procedimiento|paso\s+a\s+paso|muestra(?:me)?\s+los?\s+pasos?|desarrollo|explica(?:me|lo)?\s+(?:la\s+)?operacion/.test(plain(input));
  }

  function calculationSteps(expression, value, detailed) {
    const compact = expression.replace(/\s+/g, "");
    const binary = compact.match(/^\(?(-?\d+(?:\.\d+)?)\)?([+\-*/^])\(?(-?\d+(?:\.\d+)?)\)?$/);
    if (binary) {
      const left = Number(binary[1]);
      const right = Number(binary[3]);
      const operation = binary[2];
      const names = { "+": "sumar", "-": "restar", "*": "multiplicar", "/": "dividir", "^": "elevar" };
      const symbols = { "+": "+", "-": "−", "*": "×", "/": "÷", "^": "^" };
      const steps = [
        `Identifico los valores: ${left} y ${right}.`,
        `Aplico la operación: ${left} ${symbols[operation]} ${right} = ${value}.`,
      ];
      if (detailed) steps.unshift(`La instrucción pide ${names[operation]} ${left} ${operation === "*" ? "por" : operation === "/" ? "entre" : "y"} ${right}.`);
      return steps;
    }
    return [
      "Primero resuelvo los paréntesis y las potencias.",
      "Después realizo multiplicaciones o divisiones de izquierda a derecha.",
      `Finalmente hago sumas o restas y obtengo ${value}.`,
    ];
  }

  function calculationResponse(input) {
    const text = plain(input);
    const detailed = wantsProcedure(input);
    let match = text.match(/(?:cuanto\s+(?:es|representa)|calcula(?:r)?|obten|dime)?\s*(\d+(?:[.,]\d+)?)\s*%\s*(?:de|del)\s*(-?\d+(?:[.,]\d+)?)/);
    if (match) {
      const percentage = scalar(match[1]);
      const base = scalar(match[2]);
      const value = tidy((percentage / 100) * base);
      return { type: "calculation", title: detailed ? "Porcentaje con procedimiento" : "Porcentaje", expression: `${percentage}% de ${base}`, value, steps: [`Convierto ${percentage}% en ${percentage / 100}.`, `Multiplico ${percentage / 100} × ${base} = ${value}.`] };
    }
    match = text.match(/(?:raiz\s+cuadrada\s+(?:de)?|sqrt\s*)\s*\(?\s*(-?\d+(?:[.,]\d+)?)\s*\)?/);
    if (match) {
      const number = scalar(match[1]);
      if (number < 0) return { type: "error", message: "La raíz cuadrada real requiere un número mayor o igual que cero." };
      const value = tidy(Math.sqrt(number));
      return { type: "calculation", title: detailed ? "Raíz cuadrada con procedimiento" : "Raíz cuadrada", expression: `√${number}`, value, steps: [`Busco el número que, multiplicado por sí mismo, produce ${number}.`, `${value} × ${value} = ${number}.`] };
    }
    match = text.match(/promedio\s+(?:de\s+)?(.+)/);
    if (match) {
      const numbers = match[1].match(/-?\d+(?:[.,]\d+)?/g)?.map(scalar) || [];
      if (numbers.length >= 2) {
        const sum = numbers.reduce((total, number) => total + number, 0);
        const value = tidy(sum / numbers.length);
        return { type: "calculation", title: detailed ? "Promedio con procedimiento" : "Promedio", expression: `(${numbers.join(" + ")}) ÷ ${numbers.length}`, value, steps: [`Sumo los valores: ${tidy(sum)}.`, `Divido ${tidy(sum)} entre la cantidad de datos (${numbers.length}) y obtengo ${value}.`] };
      }
    }
    const expression = expressionFromText(input);
    if (!expression) return null;
    const value = evaluateExpression(expression);
    return { type: "calculation", title: detailed ? "Cálculo con procedimiento" : "Cálculo", expression: expression.replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\^/g, " ^ "), value, steps: calculationSteps(expression, value, detailed) };
  }

  function equationResponse(input) {
    const source = plain(input)
      .replace(/^(?:resuelve|resolver|soluciona|encuentra\s+x(?:\s+en)?)\s*/, "")
      .replace(/\s+(?:y\s+)?(?:dame(?:lo)?|muestra(?:me)?|explica(?:me|lo)?|presenta(?:me)?)(?:\s+el\s+resultado)?(?:\s+con)?\s+(?:el\s+)?(?:procedimiento|proceso|pasos?|desarrollo|explicacion).*$/, "")
      .replace(/,/g, ".")
      .replace(/\s+/g, "");
    const match = source.match(/^([+-]?(?:\d+(?:\.\d+)?)?)\*?x([+-]\d+(?:\.\d+)?)?=(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const a = coefficient(match[1]);
    const b = match[2] ? Number(match[2]) : 0;
    const rhs = Number(match[3]);
    if (Math.abs(a) < 1e-15) return { type: "error", message: "El coeficiente de x no puede ser cero." };
    const value = tidy((rhs - b) / a);
    return {
      type: "calculation",
      title: "Ecuación lineal",
      expression: `${a}x ${b < 0 ? "−" : "+"} ${Math.abs(b)} = ${rhs}`,
      value,
      resultLabel: `x = ${value}`,
      steps: [`Paso el término independiente al otro lado: ${a}x = ${tidy(rhs - b)}.`, `Divido ambos lados entre ${a}: x = ${value}.`],
    };
  }

  function continuationCalculation(input, context) {
    if (!Number.isFinite(context?.lastNumericResult)) return null;
    const text = plain(input);
    const last = context.lastNumericResult;
    if (/^(?:y\s+)?(?:ahora\s+)?(?:la\s+)?mitad$/.test(text)) return calculationResponse(`${last} / 2`);
    if (/^(?:y\s+)?(?:ahora\s+)?(?:el\s+)?doble$/.test(text)) return calculationResponse(`${last} * 2`);
    const patterns = [
      { pattern: /^(?:y\s+)?(?:ahora\s+)?(?:sumale|suma|mas)\s+(.+)$/, op: "+" },
      { pattern: /^(?:y\s+)?(?:ahora\s+)?(?:restale|resta|menos)\s+(.+)$/, op: "-" },
      { pattern: /^(?:y\s+)?(?:ahora\s+)?(?:multiplicalo|multiplica|multiplicado|por)(?:\s+(?:eso|el\s+resultado))?\s+(?:por\s+)?(.+)$/, op: "*" },
      { pattern: /^(?:y\s+)?(?:ahora\s+)?(?:dividelo|divide|dividido|entre)(?:\s+(?:eso|el\s+resultado))?\s+(?:entre\s+|por\s+)?(.+)$/, op: "/" },
    ];
    for (const item of patterns) {
      const match = text.match(item.pattern);
      if (match) return calculationResponse(`${last} ${item.op} (${match[1]})`);
    }
    return null;
  }

  function conceptAnswer(input) {
    const text = plain(input);
    const asksConcept = /^(que|como|cual|explica|define|para que|por que)|significa|concepto|diferencia/.test(text);
    const namesTopic = /^(?:(?:quiero|necesito|me gustaria|ayudame a)\s+)?(?:(?:aprender|entender|estudiar|saber)\s+)?(?:sobre\s+|acerca\s+de\s+)?(?:investigacion de operaciones|programacion lineal|metodo simplex|simplex|modelo de transporte|transporte|modelo de asignacion|asignacion|eoq|cantidad economica|punto de reorden|region factible|funcion objetivo|variables? de decision|restricciones?|holgura|inventario de seguridad)$/i.test(text);
    if (!asksConcept && !namesTopic) return null;
    const concepts = [
      {
        pattern: /region factible/,
        title: "Región factible",
        answer: "Es el conjunto de puntos que satisface simultáneamente todas las restricciones y la no negatividad. En dos variables se identifica dibujando cada recta, determinando el semiplano permitido y observando la intersección común. El óptimo lineal, si es finito, se encuentra en uno o más vértices de esa región.",
      },
      {
        pattern: /investigacion de operaciones/,
        title: "Investigación de Operaciones",
        answer: "Es el uso de modelos matemáticos y métodos de optimización para elegir la mejor decisión posible con recursos limitados. Convierte una situación real en variables, objetivo y restricciones; luego calcula e interpreta una solución.",
      },
      {
        pattern: /optimizar|optimizacion/,
        title: "Optimización",
        answer: "Optimizar significa encontrar, entre todas las alternativas factibles, la que produce el mejor valor del objetivo: el mayor beneficio o el menor costo, tiempo o desperdicio.",
      },
      {
        pattern: /programacion lineal/,
        title: "Programación lineal",
        answer: "Es una técnica para maximizar o minimizar una función objetivo lineal, sujeta a restricciones lineales. Sus elementos son variables de decisión, función objetivo, restricciones y condiciones de no negatividad.",
      },
      {
        pattern: /simplex/,
        title: "Método simplex",
        answer: "El simplex avanza entre soluciones básicas factibles. En cada tabla selecciona una variable entrante que mejora Z, calcula la variable saliente con la menor razón positiva y realiza un pivoteo. Termina cuando la fila objetivo ya no contiene una mejora posible.",
      },
      {
        pattern: /transporte/,
        title: "Modelo de transporte",
        answer: "Distribuye unidades desde varios orígenes hacia varios destinos al menor costo, respetando la oferta de cada origen y la demanda de cada destino. Si los totales no coinciden, se agrega un origen o destino ficticio para balancear el modelo.",
      },
      {
        pattern: /asignacion/,
        title: "Modelo de asignación",
        answer: "Es un caso especial de transporte donde cada recurso se asigna a una sola tarea y cada tarea recibe un solo recurso. Puede minimizar tiempo o costo, o maximizar beneficio o puntuación.",
      },
      {
        pattern: /punto de reorden|reorden/,
        title: "Punto de reorden",
        answer: "Es el nivel de inventario que activa un pedido nuevo. Con demanda constante se calcula R = dL + SS, donde d es la demanda diaria, L el tiempo de entrega y SS el inventario de seguridad.",
      },
      {
        pattern: /eoq|cantidad economica|lote economico/,
        title: "Cantidad económica de pedido",
        answer: "EOQ determina cuánto pedir para equilibrar el costo de ordenar y el costo de mantener inventario. La fórmula básica es Q* = √(2DS/H), con demanda anual D, costo por pedido S y costo anual de mantener una unidad H.",
      },
      {
        pattern: /variable.*decision/,
        title: "Variables de decisión",
        answer: "Representan las cantidades que la organización puede elegir, por ejemplo unidades de productos x e y. Deben definirse con nombre, unidad de medida y condición de no negatividad cuando corresponda.",
      },
      {
        pattern: /funcion objetivo/,
        title: "Función objetivo",
        answer: "Expresa cuantitativamente lo que se desea optimizar, como beneficio, costo o tiempo. Sus coeficientes indican el aporte de cada variable al valor total Z.",
      },
      {
        pattern: /restriccion/,
        title: "Restricciones",
        answer: "Representan límites o requisitos del problema, como capacidad, presupuesto o demanda. Cada restricción combina las variables y usa ≤, ≥ o = para compararlas con una disponibilidad o meta.",
      },
      {
        pattern: /holgura/,
        title: "Variable de holgura",
        answer: "Mide cuánto recurso queda sin utilizar en una restricción de tipo ≤. Se calcula restando el lado izquierdo al recurso disponible. Una holgura cero indica que la restricción está activa en esa solución.",
      },
      {
        pattern: /inventario.*seguridad|stock.*seguridad/,
        title: "Inventario de seguridad",
        answer: "Es una reserva adicional que protege contra variaciones de demanda o retrasos. En el punto de reorden se suma a la demanda esperada durante el tiempo de entrega.",
      },
    ];
    return concepts.find((item) => item.pattern.test(text)) || null;
  }

  function previousSubject(context) {
    const response = context?.lastSubjectResponse || context?.lastResponse;
    return response && !["conversation", "clarification", "error"].includes(response.type) ? response : null;
  }

  function topicSuggestions(response) {
    const choices = {
      calculation: ["¿Puedes explicarlo más sencillo?", "Ponme otro cálculo"],
      concept: ["¿Para qué sirve?", "Ponme un ejercicio de ese tema"],
      lp: ["¿Cómo obtuviste el óptimo?", "Ponme otro problema de programación lineal"],
      eoq: ["Explícame la fórmula", "Ponme otro ejercicio de EOQ"],
      transport: ["¿Cómo verifico el costo?", "Ponme otro ejercicio de transporte"],
      assignment: ["¿Cómo verifico la asignación?", "Ponme otro ejercicio de asignación"]
    };
    return choices[response?.type] || ["Explícame programación lineal", "Hazme una pregunta para practicar"];
  }

  function explainPrevious(context, simple) {
    const previous = previousSubject(context);
    if (!previous) {
      return { type: "conversation", title: "Empecemos juntos", answer: "Todavía no hay una respuesta anterior que pueda explicar. Dime qué tema estás estudiando o pega el ejercicio y comenzaré desde el primer paso.", suggestions: ["Quiero aprender programación lineal", "¿Qué es la región factible?"] };
    }
    if (previous.type === "calculation") {
      const details = simple ? "Tomé los números en el orden indicado y apliqué la operación antes de escribir el resultado." : (previous.steps?.join(" ") || "Apliqué el orden de operaciones.");
      return { type: "conversation", title: simple ? "Dicho de forma sencilla" : "Explicación del cálculo", answer: previous.expression + " produce " + previous.value + ". " + details, suggestions: topicSuggestions(previous) };
    }
    const explanations = {
      lp: "Primero identifiqué las variables, la función objetivo y las restricciones. Después formé la región factible, evalué sus vértices y elegí el valor que optimiza Z.",
      eoq: "Usé Q* = √(2DS/H) para equilibrar los costos de ordenar y mantener inventario. Si había datos de tiempo, también calculé el punto de reorden.",
      transport: "Distribuí las unidades respetando cada oferta y demanda. Luego sumé cantidad × costo de todas las rutas usadas y comparé soluciones factibles.",
      assignment: "Elegí una tarea distinta para cada recurso, evitando repeticiones, y comparé los totales hasta encontrar la mejor asignación.",
      concept: previous.answer
    };
    return { type: "conversation", title: simple ? "Dicho de forma sencilla" : "Continuemos la explicación", answer: explanations[previous.type] || previous.answer || "Retomemos la respuesta anterior paso a paso.", suggestions: topicSuggestions(previous) };
  }

  function exerciseFor(text, context) {
    const topic = text + " " + (context?.lastTopic || "");
    if (/transporte/.test(topic)) return "Transporte costos: 4 8 / 6 5; oferta=30 20; demanda=25 25";
    if (/asignacion/.test(topic)) return "Asignación mínima matriz: 7 4 8 / 5 6 3 / 9 2 7";
    if (/eoq|inventario|reorden/.test(topic)) return "Calcula EOQ si D=10000, S=40, H=2, dias=360, entrega=4, seguridad=15";
    if (/simplex|programacion lineal|region factible|lp/.test(topic)) return "Maximiza Z = 3x + 5y, sujeto a x <= 4; 2y <= 12; 3x + 2y <= 18";
    return "¿Cuánto es 20% de 350? Después puedes preguntarme cómo lo calculé.";
  }

  function advancedConversationReply(input, context) {
    const text = plain(input);
    if (/^(hola|buenos dias|buenas tardes|buenas noches|hey|que tal)(?:[\s,;:].*)?$/.test(text)) {
      return { type: "conversation", title: "¡Hola! ¿Qué te gustaría estudiar?", answer: "Estoy listo para conversar contigo, no necesitas escribir una orden exacta. Puedes contarme qué tema te cuesta, pedir una explicación, practicar con un ejercicio o darme un problema completo.", suggestions: ["Tengo examen, ¿por dónde empiezo?", "Quiero aprender programación lineal desde cero"] };
    }
    if (/como estas|como te va|todo bien/.test(text)) {
      return { type: "conversation", title: "¡Muy bien y listo para ayudarte!", answer: "Podemos conversar de manera natural. ¿Quieres entender un tema, resolver un ejercicio o practicar para una evaluación?", suggestions: ["Explícame qué es optimizar", "Hazme una pregunta para practicar"] };
    }
    if (/quien eres|como te llamas|eres un (?:robot|asistente)/.test(text)) {
      return { type: "conversation", title: "Soy tu asistente académico de IO", answer: "Fui preparado para explicar Investigación de Operaciones y matemáticas relacionadas. Trabajo directamente en este navegador, sin cuentas ni servicios de pago, y recuerdo el contexto de esta conversación.", suggestions: ["¿Qué puedes hacer?", "Quiero aprender desde cero"] };
    }
    if (/tengo (?:un )?examen|por donde empiezo|quiero aprender|quiero estudiar|desde cero|no se nada|ayudame a estudiar/.test(text)) {
      return { type: "conversation", title: "Construyamos una ruta sencilla", answer: "Empecemos por tres ideas: 1) definir las variables de decisión, 2) expresar qué queremos maximizar o minimizar y 3) traducir los límites en restricciones. Después practicamos región factible y solución óptima. Dime cuál de esas partes deseas revisar primero.", suggestions: ["¿Qué son las variables de decisión?", "Explícame la función objetivo", "Ponme un ejercicio fácil"] };
    }
    if (/^(?:no entendi|no lo entiendo|me perdi|puedes repetir|repitelo|explicalo otra vez)\b[\s,;:]*(?:.*)?$/.test(text) || /mas (?:facil|sencillo)|en palabras simples/.test(text)) return explainPrevious(context, true);
    if (/^(?:continua|continuemos|sigue|sigamos|si[\s,;:]+continuemos|si[\s,;:]+sigue)\b[\s,;:]*(?:.*)?$/.test(text)) return explainPrevious(context, false);
    if (/para que sirve|en que se usa|cuando se utiliza|ejemplo de la vida real/.test(text)) {
      const previous = previousSubject(context);
      const uses = {
        "Programación lineal": "Se usa para repartir recursos limitados —tiempo, dinero, materiales o personal— de la manera más conveniente.",
        "Modelo de transporte": "Se usa para decidir cuánto enviar de cada origen a cada destino con el menor costo posible.",
        "Modelo de asignación": "Se usa para emparejar personas, máquinas o vehículos con tareas sin repetir asignaciones.",
        "Cantidad económica de pedido": "Se usa para decidir cuánto inventario pedir y evitar costos innecesarios.",
        "Región factible": "Sirve para visualizar todas las decisiones que cumplen simultáneamente las limitaciones del problema."
      };
      return { type: "conversation", title: "Aplicación práctica", answer: uses[previous?.title] || "En Investigación de Operaciones sirve para convertir una decisión real en un modelo verificable y comparar alternativas antes de elegir.", suggestions: ["Ponme un ejemplo", "Hazme una pregunta para practicar"] };
    }
    if (/hazme una pregunta|preguntame algo|quiero practicar|ponme un ejercicio|dame un ejercicio/.test(text)) {
      return { type: "conversation", title: "Práctica propuesta", answer: exerciseFor(text, context), suggestions: ["Dame una pista", "Muéstrame el procedimiento"] };
    }
    if (/^(si|claro|de acuerdo|esta bien|ok|vale)[\s,;:.]*$/.test(text)) {
      return { type: "conversation", title: "Perfecto, seguimos", answer: "Elige una de estas opciones o cuéntame con tus propias palabras qué necesitas.", suggestions: topicSuggestions(previousSubject(context)) };
    }
    if (/pelicula|cancion|clima|futbol|receta|restaurante/.test(text)) {
      return { type: "conversation", title: "Puedo conversar, con un enfoque académico", answer: "Ese tema queda fuera de este asistente. Si quieres, puedo relacionarlo con decisiones, optimización o cálculos; también podemos volver a programación lineal, transporte, asignación o inventarios.", suggestions: ["¿Qué es optimizar?", "Ponme un ejercicio de transporte"] };
    }
    return null;
  }
  function conversationalReply(input, context) {
    const text = plain(input);
    if (/^(hola|buenos dias|buenas tardes|buenas noches|hey|que tal)$/.test(text)) {
      return { type: "conversation", title: "¡Hola!", answer: "Podemos conversar y avanzar paso a paso. Resuelvo operaciones matemáticas, porcentajes, promedios, ecuaciones sencillas y los modelos de Investigación de Operaciones requeridos. También recuerdo el resultado anterior para preguntas de seguimiento.", suggestions: ["¿Cuánto es 5*20 y dámelo con procedimiento?", "¿Qué significa región factible?"] };
    }
    if (/^(gracias|muchas gracias|excelente|perfecto|entendido)$/.test(text)) {
      return { type: "conversation", title: "Con gusto", answer: "Puedes continuar con otra pregunta o modificar los datos del ejercicio anterior. Si escribes un problema incompleto, te indicaré qué información falta." };
    }
    if (/^(adios|hasta luego|nos vemos)$/.test(text)) {
      return { type: "conversation", title: "Hasta luego", answer: "La conversación queda guardada en este navegador. Cuando regreses, podrás continuar o iniciar una conversación nueva." };
    }
    if (/que puedes hacer|en que puedes ayudar|como me puedes ayudar|ayuda$/.test(text)) {
      return { type: "conversation", title: "Puedo ayudarte con", answer: "Operaciones como 5×20, expresiones con paréntesis y potencias, porcentajes, raíces, promedios, ecuaciones lineales y preguntas conceptuales. También resuelvo programación lineal de dos variables, simplex básico, transporte, asignación, EOQ y punto de reorden." };
    }
    if (/^(por que|como llegaste|explica(?:me)?lo|explicame|puedes explicarme|como lo calculaste)(?:\s+mas\s+(?:facil|sencillo))?$/.test(text)) {
      const previous = context?.lastResponse;
      if (!previous) return { type: "clarification", message: "Primero haz una pregunta o plantea un ejercicio; después podré explicar cómo obtuve la respuesta." };
      if (previous.type === "calculation") {
        return { type: "conversation", title: "Explicación del cálculo", answer: `${previous.expression} produce ${previous.value}. ${previous.steps?.join(" ") || "Apliqué el orden de operaciones."}` };
      }
      if (previous.type === "lp") {
        return { type: "conversation", title: "Cómo se obtuvo", answer: "Formé la región factible con todas las restricciones, calculé sus vértices, descarté los que incumplen el modelo y evalué la función objetivo en cada punto. El valor reportado es el mejor de los puntos factibles." };
      }
      if (previous.type === "eoq") {
        return { type: "conversation", title: "Cómo se obtuvo", answer: "Apliqué Q* = √(2DS/H) para equilibrar los costos de ordenar y mantener. Después calculé la demanda diaria y usé R = dL + SS para el punto de reorden." };
      }
      if (previous.type === "transport" || previous.type === "assignment") {
        return { type: "conversation", title: "Cómo se obtuvo", answer: "Comparé combinaciones factibles respetando la oferta, demanda o exclusividad de tareas. La solución mostrada cumple todas las condiciones y tiene el mejor valor total encontrado." };
      }
      return { type: "conversation", title: "Explicación", answer: previous.answer || previous.message || "La respuesta anterior se obtuvo aplicando la definición y los datos que proporcionaste." };
    }
    if (/^(?:dame|pon)\s+otro\s+ejemplo$/.test(text)) {
      const previousType = context?.lastResponse?.type;
      const examples = {
        calculation: "Prueba: ¿Cuánto es (18 + 6) ÷ 3? Después pregunta: ¿y multiplicado por 5?",
        lp: "Prueba: Maximiza Z = 3x + 5y, sujeto a x <= 4; 2y <= 12; 3x + 2y <= 18.",
        eoq: "Prueba: Calcula EOQ si D=10000, S=40, H=2, dias=360, entrega=4, seguridad=15.",
        transport: "Prueba: Transporte costos: 4 8 / 6 5; oferta=30 20; demanda=25 25.",
        assignment: "Prueba: Asignación mínima matriz: 7 4 8 / 5 6 3 / 9 2 7.",
      };
      return { type: "conversation", title: "Otro ejemplo", answer: examples[previousType] || "Prueba: ¿Cuánto es 20% de 350? O escribe el ejemplo de programación lineal de la rúbrica." };
    }
    return null;
  }

  function parseLinearProgram(input) {
    const source = plain(input)
      .replace(/−/g, "-")
      .replace(/mayor\s+o\s+igual\s+(?:que|a)/g, ">=")
      .replace(/menor\s+o\s+igual\s+(?:que|a)/g, "<=")
      .replace(/multiplicado\s+por|por/g, "*")
      .replace(/\bmas\b/g, "+")
      .replace(/\bmenos\b/g, "-");
    const objective = source.match(/\b(maximiza(?:r)?|maximice|maximo|max|minimiza(?:r)?|minimice|minimo|min)\b[\s\S]*?(?:z\s*=\s*)?([+-]?\d+(?:[.,]\d+)?)\s*\*?\s*x\s*([+-])\s*(\d+(?:[.,]\d+)?)\s*\*?\s*y/i);
    if (!objective) return null;
    const goal = /^min/i.test(objective[1]) ? "min" : "max";
    const c1 = scalar(objective[2]);
    const c2 = (objective[3] === "-" ? -1 : 1) * scalar(objective[4]);
    const constraints = [];
    const occupied = [];
    const mixedPattern = /([+-]?(?:\d+(?:[.,]\d+)?)?)\s*\*?\s*x\s*([+-])\s*((?:\d+(?:[.,]\d+)?)?)\s*\*?\s*y\s*(<=|>=|≤|≥|=)\s*(-?\d+(?:[.,]\d+)?)/gi;
    let match;
    while ((match = mixedPattern.exec(source)) !== null) {
      const a = coefficient(match[1]);
      const b = (match[2] === "-" ? -1 : 1) * coefficient(match[3]);
      constraints.push({ a, b, op: operator(match[4]), rhs: scalar(match[5]) });
      occupied.push([match.index, match.index + match[0].length]);
    }
    const singlePattern = /([+-]?(?:\d+(?:[.,]\d+)?)?)\s*\*?\s*([xy])\s*(<=|>=|≤|≥|=)\s*(-?\d+(?:[.,]\d+)?)/gi;
    while ((match = singlePattern.exec(source)) !== null) {
      if (occupied.some(([start, end]) => match.index >= start && match.index < end)) continue;
      const amount = coefficient(match[1]);
      const candidate = {
        a: match[2].toLowerCase() === "x" ? amount : 0,
        b: match[2].toLowerCase() === "y" ? amount : 0,
        op: operator(match[3]),
        rhs: scalar(match[4]),
      };
      if (candidate.op === ">=" && candidate.rhs === 0 && (candidate.a === 1 || candidate.b === 1)) continue;
      constraints.push(candidate);
    }
    if (!constraints.length) {
      return { incomplete: true, message: "Reconocí la función objetivo, pero faltan restricciones con formato como 2x + y <= 100." };
    }
    return { goal, c1, c2, constraints };
  }

  function labeledNumber(source, aliases) {
    const normalized = plain(source);
    const pattern = new RegExp(`(?:^|[\\s,;])(?:${aliases})\\s*(?::|=|es\\b|de\\b)\\s*(-?\\d+(?:[.,]\\d+)?)`, "i");
    const match = normalized.match(pattern);
    return match ? scalar(match[1]) : null;
  }

  function parseEOQ(input) {
    const text = plain(input);
    if (!/\beoq\b|lote economico|cantidad economica|punto de reorden/.test(text)) return null;
    const data = {
      demand: labeledNumber(input, "d|demanda(?:\\s+anual)?"),
      orderCost: labeledNumber(input, "s|costo(?:\\s+por)?\\s+pedido|costo\\s+de\\s+ordenar"),
      holdingCost: labeledNumber(input, "h|mantenimiento|costo(?:\\s+de)?\\s+mantener"),
      workingDays: labeledNumber(input, "dias|dias\\s+laborables") ?? 360,
      leadTime: labeledNumber(input, "entrega|tiempo(?:\\s+de)?\\s+entrega|l") ?? 0,
      safetyStock: labeledNumber(input, "seguridad|inventario(?:\\s+de)?\\s+seguridad|ss") ?? 0,
    };
    const missing = [];
    if (data.demand === null) missing.push("demanda anual D");
    if (data.orderCost === null) missing.push("costo por pedido S");
    if (data.holdingCost === null) missing.push("costo de mantenimiento H");
    return missing.length ? { incomplete: true, missing } : data;
  }

  function parseTransport(input) {
    const text = plain(input);
    if (!/transporte|distribucion/.test(text)) return null;
    const source = String(input).replace(/\[\s*\[/g, "").replace(/\]\s*\]/g, "").replace(/\]\s*,\s*\[/g, " / ");
    const costs = source.match(/(?:costos?|matriz)\s*[:=]\s*([\s\S]*?)(?=\s*;\s*oferta)/i);
    const supply = source.match(/oferta\s*[:=]\s*([^;\n]+)(?=\s*;\s*demanda)/i);
    const demand = source.match(/demanda\s*[:=]\s*([^;\n.]+)\s*\.?\s*$/i);
    if (!costs || !supply || !demand) {
      return { incomplete: true, message: "Usa: Transporte costos: fila1 / fila2; oferta=...; demanda=..." };
    }
    return {
      costs: E.parseMatrix(costs[1].replace(/\s*\/\s*/g, "\n")),
      supply: E.parseVector(supply[1], "Oferta"),
      demand: E.parseVector(demand[1], "Demanda"),
    };
  }

  function parseAssignment(input) {
    const text = plain(input);
    if (!/asignacion/.test(text)) return null;
    const source = String(input).replace(/\[\s*\[/g, "").replace(/\]\s*\]/g, "").replace(/\]\s*,\s*\[/g, " / ");
    const matrix = source.match(/(?:matriz|costos?|beneficios?)\s*[:=]\s*([\s\S]+)$/i);
    if (!matrix) return { incomplete: true, message: "Usa: Asignación mínima matriz: fila1 / fila2 / fila3" };
    return {
      goal: /maxim|beneficio|puntuacion/.test(text) ? "max" : "min",
      costs: E.parseMatrix(matrix[1].replace(/\s*\/\s*/g, "\n")),
    };
  }

  function domainResponse(clean) {
    try {
      const linear = parseLinearProgram(clean);
      if (linear) {
        if (linear.incomplete) return { type: "clarification", message: linear.message, pending: { kind: "lp", source: clean } };
        const result = E.solveLinearProgram(linear);
        return { type: "lp", input: linear, result, value: result.optimumValue, resolvedPending: "lp" };
      }
      const eoq = parseEOQ(clean);
      if (eoq) {
        if (eoq.incomplete) return { type: "clarification", message: `Faltan: ${eoq.missing.join(", ")}.`, example: "Puedes responder solamente con el dato faltante, por ejemplo: H=2", pending: { kind: "eoq", source: clean } };
        const result = E.calculateEOQ(eoq);
        return { type: "eoq", input: eoq, result, value: result.eoq, resolvedPending: "eoq" };
      }
      const transport = parseTransport(clean);
      if (transport) {
        if (transport.incomplete) return { type: "clarification", message: transport.message, pending: { kind: "transport", source: clean } };
        const result = E.solveTransportation(transport);
        return { type: "transport", input: transport, result, value: result.totalCost, resolvedPending: "transport" };
      }
      const assignment = parseAssignment(clean);
      if (assignment) {
        if (assignment.incomplete) return { type: "clarification", message: assignment.message, pending: { kind: "assignment", source: clean } };
        const result = E.solveAssignment(assignment);
        return { type: "assignment", input: assignment, result, value: result.total, resolvedPending: "assignment" };
      }
    } catch (error) {
      return { type: "error", message: error.message || "No fue posible interpretar los datos." };
    }
    return null;
  }

  function answerQuestion(input, context) {
    const clean = String(input ?? "").trim();
    if (!clean) return remember(context, clean, { type: "clarification", message: "Escribe una pregunta o un ejercicio para comenzar." });
    if (clean.length > 1600) return remember(context, clean, { type: "clarification", message: "La pregunta supera 1,600 caracteres. Divide el problema en partes más pequeñas." });

    try {
      const advancedConversation = advancedConversationReply(clean, context);
      if (advancedConversation) return remember(context, clean, advancedConversation);

      const conversation = conversationalReply(clean, context);
      if (conversation) return remember(context, clean, conversation);

      const followUp = continuationCalculation(clean, context);
      if (followUp) return remember(context, clean, followUp);

      const concept = conceptAnswer(clean);
      if (concept) return remember(context, clean, { type: "concept", title: concept.title, answer: concept.answer });

      let domain = domainResponse(clean);
      if (domain && context?.pending && domain.pending?.kind === context.pending.kind) {
        const combined = `${context.pending.source}; ${clean}`;
        const continued = domainResponse(combined);
        if (continued && !continued.pending) domain = { ...continued, continuation: true };
        else if (continued?.pending) domain = { ...continued, pending: { ...continued.pending, source: combined } };
      }
      if (domain) return remember(context, clean, domain);

      const equation = equationResponse(clean);
      if (equation) return remember(context, clean, equation);

      const calculation = calculationResponse(clean);
      if (calculation) return remember(context, clean, calculation);

      if (context?.pending) {
        const combined = `${context.pending.source}; ${clean}`;
        const continued = domainResponse(combined);
        if (continued) {
          const response = continued.pending
            ? { ...continued, pending: { ...continued.pending, source: combined } }
            : { ...continued, continuation: true };
          return remember(context, clean, response);
        }
      }
    } catch (error) {
      return remember(context, clean, { type: "error", message: error.message || "No fue posible interpretar los datos." });
    }

    const response = {
      type: "conversation",
      title: "Conversemos sobre tu pregunta",
      answer: "Entiendo que quieres hablar de: «" + clean.slice(0, 180) + "». No pude convertirlo todavía en un cálculo o modelo. Cuéntame qué deseas obtener, qué datos tienes y qué parte necesitas entender; te ayudaré a formularlo paso a paso.",
      suggestions: ["Ayúdame a plantear el problema", "¿Qué datos necesitas?", "Muéstrame un ejemplo parecido"],
    };
    return remember(context, clean, response);
  }

  function rebuildContext(conversation) {
    const context = createContext();
    for (const item of Array.isArray(conversation) ? conversation : []) {
      if (item?.role === "user" && item.text) answerQuestion(item.text, context);
    }
    return context;
  }

  return {
    plain,
    createContext,
    rebuildContext,
    evaluateExpression,
    calculationResponse,
    parseLinearProgram,
    parseEOQ,
    parseTransport,
    parseAssignment,
    answerQuestion,
  };
});
