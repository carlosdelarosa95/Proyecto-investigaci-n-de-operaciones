(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.IOEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EPS = 1e-8;

  function number(value, label) {
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error(`${label} es obligatorio.`);
    }
    const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
    if (!Number.isFinite(parsed)) throw new Error(`${label} debe ser un número válido.`);
    return parsed;
  }

  function clean(value, digits = 4) {
    if (Math.abs(value) < EPS) return 0;
    return Number(value.toFixed(digits));
  }

  function normalizeConstraints(constraints) {
    if (!Array.isArray(constraints) || constraints.length === 0) {
      throw new Error("Agrega al menos una restricción.");
    }
    return constraints.map((item, index) => {
      const op = item.op || "<=";
      if (!["<=", ">=", "="].includes(op)) {
        throw new Error(`El signo de la restricción ${index + 1} no es válido.`);
      }
      return {
        a: number(item.a, `Coeficiente de x en R${index + 1}`),
        b: number(item.b, `Coeficiente de y en R${index + 1}`),
        op,
        rhs: number(item.rhs, `Término independiente de R${index + 1}`),
      };
    });
  }

  function constraintHolds(c, x, y, tolerance = 1e-7) {
    const lhs = c.a * x + c.b * y;
    if (c.op === "<=") return lhs <= c.rhs + tolerance;
    if (c.op === ">=") return lhs >= c.rhs - tolerance;
    return Math.abs(lhs - c.rhs) <= tolerance;
  }

  function uniquePoints(points) {
    const output = [];
    for (const point of points) {
      if (!output.some((item) => Math.hypot(item.x - point.x, item.y - point.y) < 1e-6)) {
        output.push({ x: clean(point.x, 8), y: clean(point.y, 8) });
      }
    }
    return output;
  }

  function lineIntersection(first, second) {
    const determinant = first.a * second.b - second.a * first.b;
    if (Math.abs(determinant) < EPS) return null;
    return {
      x: (first.rhs * second.b - second.rhs * first.b) / determinant,
      y: (first.a * second.rhs - second.a * first.rhs) / determinant,
    };
  }

  function hasImprovingRay(constraints, c1, c2, goal) {
    const angles = [0, Math.PI / 2];
    for (const c of constraints) {
      let theta = Math.atan2(-c.a, c.b);
      while (theta < 0) theta += Math.PI * 2;
      if (theta >= -EPS && theta <= Math.PI / 2 + EPS) angles.push(Math.max(0, Math.min(Math.PI / 2, theta)));
    }
    angles.sort((a, b) => a - b);
    const candidates = [...angles];
    for (let index = 0; index < angles.length - 1; index += 1) {
      candidates.push((angles[index] + angles[index + 1]) / 2);
    }
    for (let index = 0; index <= 720; index += 1) candidates.push((Math.PI / 2) * (index / 720));

    return candidates.some((theta) => {
      const dx = Math.cos(theta);
      const dy = Math.sin(theta);
      const feasibleDirection = constraints.every((c) => {
        const delta = c.a * dx + c.b * dy;
        if (c.op === "<=") return delta <= 1e-7;
        if (c.op === ">=") return delta >= -1e-7;
        return Math.abs(delta) <= 1e-7;
      });
      if (!feasibleDirection) return false;
      const improvement = c1 * dx + c2 * dy;
      return goal === "max" ? improvement > 1e-7 : improvement < -1e-7;
    });
  }

  function solveLinearProgram(input) {
    const goal = input.goal === "min" ? "min" : "max";
    const c1 = number(input.c1, "Coeficiente de x en la función objetivo");
    const c2 = number(input.c2, "Coeficiente de y en la función objetivo");
    const constraints = normalizeConstraints(input.constraints);
    const boundaries = [
      ...constraints,
      { a: 1, b: 0, rhs: 0, op: "=" },
      { a: 0, b: 1, rhs: 0, op: "=" },
    ];
    const candidates = [];
    for (let i = 0; i < boundaries.length; i += 1) {
      for (let j = i + 1; j < boundaries.length; j += 1) {
        const point = lineIntersection(boundaries[i], boundaries[j]);
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        if (point.x < -EPS || point.y < -EPS) continue;
        if (constraints.every((c) => constraintHolds(c, point.x, point.y))) candidates.push(point);
      }
    }
    if (constraints.every((c) => constraintHolds(c, 0, 0))) candidates.push({ x: 0, y: 0 });
    const vertices = uniquePoints(candidates).map((point) => ({
      ...point,
      z: clean(c1 * point.x + c2 * point.y, 8),
    }));
    if (vertices.length === 0) {
      return {
        status: "infeasible",
        goal,
        c1,
        c2,
        constraints,
        vertices: [],
        message: "No existe un punto que cumpla simultáneamente las restricciones y la no negatividad.",
      };
    }
    const unbounded = hasImprovingRay(constraints, c1, c2, goal);
    if (unbounded) {
      return {
        status: "unbounded",
        goal,
        c1,
        c2,
        constraints,
        vertices,
        message: "La región tiene una dirección que mejora Z indefinidamente; no existe un óptimo finito.",
      };
    }
    const optimumValue = vertices.reduce(
      (best, point) => (goal === "max" ? Math.max(best, point.z) : Math.min(best, point.z)),
      goal === "max" ? -Infinity : Infinity,
    );
    const optima = vertices.filter((point) => Math.abs(point.z - optimumValue) < 1e-6);
    const ordered = [...vertices].sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
    return {
      status: "optimal",
      goal,
      c1,
      c2,
      constraints,
      vertices: ordered,
      optimumValue: clean(optimumValue, 6),
      optima,
      multipleOptima: optima.length > 1,
      message: optima.length > 1
        ? "Hay soluciones óptimas múltiples sobre el segmento que une los puntos destacados."
        : "El punto destacado produce el mejor valor factible de la función objetivo.",
    };
  }

  function solveSimplex(input) {
    const c = input.c.map((value, index) => number(value, `Coeficiente objetivo ${index + 1}`));
    const A = input.A.map((row, rowIndex) => row.map((value, colIndex) => number(value, `A${rowIndex + 1},${colIndex + 1}`)));
    const b = input.b.map((value, index) => number(value, `Término independiente ${index + 1}`));
    if (A.length !== b.length || A.some((row) => row.length !== c.length)) {
      throw new Error("Las dimensiones de la matriz no coinciden.");
    }
    if (b.some((value) => value < -EPS)) {
      throw new Error("El simplex básico requiere términos independientes no negativos.");
    }
    const m = A.length;
    const n = c.length;
    const width = n + m + 1;
    const tableau = A.map((row, i) => [
      ...row,
      ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)),
      b[i],
    ]);
    tableau.push([...c.map((value) => -value), ...Array(m).fill(0), 0]);
    const basis = Array.from({ length: m }, (_, i) => n + i);
    const variableNames = [
      ...Array.from({ length: n }, (_, i) => `x${i + 1}`),
      ...Array.from({ length: m }, (_, i) => `s${i + 1}`),
      "RHS",
    ];
    const iterations = [];
    const snapshot = (note) => ({
      note,
      basis: basis.map((index) => variableNames[index]),
      tableau: tableau.map((row) => row.map((value) => clean(value, 6))),
    });
    iterations.push(snapshot("Tabla inicial con variables de holgura."));

    for (let step = 0; step < 50; step += 1) {
      const objective = tableau[m];
      let entering = -1;
      let mostNegative = -EPS;
      for (let j = 0; j < width - 1; j += 1) {
        if (objective[j] < mostNegative) {
          mostNegative = objective[j];
          entering = j;
        }
      }
      if (entering === -1) {
        const values = Array(n + m).fill(0);
        basis.forEach((variable, row) => { values[variable] = tableau[row][width - 1]; });
        return {
          status: "optimal",
          optimumValue: clean(tableau[m][width - 1], 6),
          values: values.slice(0, n).map((value) => clean(value, 6)),
          slack: values.slice(n).map((value) => clean(value, 6)),
          iterations,
          variableNames,
        };
      }
      let leaving = -1;
      let bestRatio = Infinity;
      for (let i = 0; i < m; i += 1) {
        const coefficient = tableau[i][entering];
        if (coefficient > EPS) {
          const ratio = tableau[i][width - 1] / coefficient;
          if (ratio < bestRatio - EPS) {
            bestRatio = ratio;
            leaving = i;
          }
        }
      }
      if (leaving === -1) return { status: "unbounded", iterations, variableNames };
      const leavingName = variableNames[basis[leaving]];
      const enteringName = variableNames[entering];
      const pivot = tableau[leaving][entering];
      for (let j = 0; j < width; j += 1) tableau[leaving][j] /= pivot;
      for (let i = 0; i <= m; i += 1) {
        if (i === leaving) continue;
        const factor = tableau[i][entering];
        for (let j = 0; j < width; j += 1) tableau[i][j] -= factor * tableau[leaving][j];
      }
      basis[leaving] = entering;
      iterations.push(snapshot(`Entra ${enteringName}; sale ${leavingName}. Pivote = ${clean(pivot, 6)}.`));
    }
    return { status: "iteration_limit", iterations, variableNames };
  }

  function solveTransportation(input) {
    const originalCosts = input.costs.map((row, i) => row.map((value, j) => number(value, `Costo ${i + 1},${j + 1}`)));
    const supply = input.supply.map((value, i) => number(value, `Oferta ${i + 1}`));
    const demand = input.demand.map((value, i) => number(value, `Demanda ${i + 1}`));
    if (!originalCosts.length || !originalCosts[0]?.length) throw new Error("Ingresa una matriz de costos.");
    if (originalCosts.length !== supply.length || originalCosts.some((row) => row.length !== demand.length)) {
      throw new Error("La matriz debe tener una fila por origen y una columna por destino.");
    }
    if ([...supply, ...demand].some((value) => value < -EPS)) throw new Error("Oferta y demanda no pueden ser negativas.");
    const costs = originalCosts.map((row) => [...row]);
    const balancedSupply = [...supply];
    const balancedDemand = [...demand];
    const totalSupply = supply.reduce((sum, value) => sum + value, 0);
    const totalDemand = demand.reduce((sum, value) => sum + value, 0);
    let dummy = null;
    if (totalSupply < totalDemand - EPS) {
      costs.push(Array(demand.length).fill(0));
      balancedSupply.push(totalDemand - totalSupply);
      dummy = { type: "origin", amount: clean(totalDemand - totalSupply) };
    } else if (totalSupply > totalDemand + EPS) {
      costs.forEach((row) => row.push(0));
      balancedDemand.push(totalSupply - totalDemand);
      dummy = { type: "destination", amount: clean(totalSupply - totalDemand) };
    }
    const rows = balancedSupply.length;
    const cols = balancedDemand.length;
    const source = 0;
    const rowStart = 1;
    const colStart = rowStart + rows;
    const sink = colStart + cols;
    const graph = Array.from({ length: sink + 1 }, () => []);
    const addEdge = (from, to, cap, cost, meta = null) => {
      const forward = { to, rev: graph[to].length, cap, initialCap: cap, cost, meta };
      const reverse = { to: from, rev: graph[from].length, cap: 0, initialCap: 0, cost: -cost, meta: null };
      graph[from].push(forward);
      graph[to].push(reverse);
      return forward;
    };
    balancedSupply.forEach((cap, i) => addEdge(source, rowStart + i, cap, 0));
    const cellEdges = [];
    for (let i = 0; i < rows; i += 1) {
      cellEdges[i] = [];
      for (let j = 0; j < cols; j += 1) {
        cellEdges[i][j] = addEdge(rowStart + i, colStart + j, Infinity, costs[i][j], { i, j });
      }
    }
    balancedDemand.forEach((cap, j) => addEdge(colStart + j, sink, cap, 0));
    const required = balancedDemand.reduce((sum, value) => sum + value, 0);
    let flow = 0;
    let totalCost = 0;
    const augmentations = [];
    while (flow < required - EPS) {
      const dist = Array(graph.length).fill(Infinity);
      const parentNode = Array(graph.length).fill(-1);
      const parentEdge = Array(graph.length).fill(-1);
      dist[source] = 0;
      for (let pass = 0; pass < graph.length - 1; pass += 1) {
        let changed = false;
        for (let u = 0; u < graph.length; u += 1) {
          if (!Number.isFinite(dist[u])) continue;
          graph[u].forEach((edge, edgeIndex) => {
            if (edge.cap > EPS && dist[u] + edge.cost < dist[edge.to] - EPS) {
              dist[edge.to] = dist[u] + edge.cost;
              parentNode[edge.to] = u;
              parentEdge[edge.to] = edgeIndex;
              changed = true;
            }
          });
        }
        if (!changed) break;
      }
      if (!Number.isFinite(dist[sink])) throw new Error("No fue posible completar la distribución.");
      let add = required - flow;
      for (let node = sink; node !== source; node = parentNode[node]) {
        add = Math.min(add, graph[parentNode[node]][parentEdge[node]].cap);
      }
      for (let node = sink; node !== source; node = parentNode[node]) {
        const edge = graph[parentNode[node]][parentEdge[node]];
        edge.cap -= add;
        graph[node][edge.rev].cap += add;
      }
      flow += add;
      totalCost += add * dist[sink];
      augmentations.push({ units: clean(add), unitCost: clean(dist[sink]), subtotal: clean(add * dist[sink]) });
    }
    const allocation = cellEdges.map((row) => row.map((edge) => clean(edge.initialCap === Infinity ? graph[edge.to][edge.rev].cap : edge.initialCap - edge.cap)));
    return {
      status: "optimal",
      totalCost: clean(totalCost, 6),
      allocation,
      costs,
      supply: balancedSupply,
      demand: balancedDemand,
      dummy,
      augmentations,
    };
  }

  function solveAssignment(input) {
    const matrix = input.costs.map((row, i) => row.map((value, j) => number(value, `Valor ${i + 1},${j + 1}`)));
    if (!matrix.length || !matrix[0]?.length) throw new Error("Ingresa una matriz de asignación.");
    const cols = matrix[0].length;
    if (matrix.some((row) => row.length !== cols)) throw new Error("Todas las filas deben tener el mismo tamaño.");
    const size = Math.max(matrix.length, cols);
    if (size > 10) throw new Error("Esta versión admite hasta 10 personas y 10 tareas.");
    const goal = input.goal === "max" ? "max" : "min";
    const padded = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (
      i < matrix.length && j < cols ? matrix[i][j] : 0
    )));
    const memo = new Map();
    const choice = new Map();
    function dp(row, mask) {
      if (row === size) return 0;
      const key = `${row}|${mask}`;
      if (memo.has(key)) return memo.get(key);
      let best = goal === "min" ? Infinity : -Infinity;
      let selected = -1;
      for (let col = 0; col < size; col += 1) {
        if (mask & (1 << col)) continue;
        const candidate = padded[row][col] + dp(row + 1, mask | (1 << col));
        const better = goal === "min" ? candidate < best - EPS : candidate > best + EPS;
        if (better) {
          best = candidate;
          selected = col;
        }
      }
      memo.set(key, best);
      choice.set(key, selected);
      return best;
    }
    const total = dp(0, 0);
    const assignments = [];
    let mask = 0;
    for (let row = 0; row < size; row += 1) {
      const col = choice.get(`${row}|${mask}`);
      if (row < matrix.length) {
        assignments.push({
          person: row,
          task: col < cols ? col : null,
          value: col < cols ? matrix[row][col] : 0,
          dummy: col >= cols,
        });
      }
      mask |= 1 << col;
    }
    return { status: "optimal", goal, total: clean(total, 6), assignments, padded: size !== matrix.length || size !== cols };
  }

  function calculateEOQ(input) {
    const demand = number(input.demand, "Demanda anual");
    const orderCost = number(input.orderCost, "Costo por pedido");
    const holdingCost = number(input.holdingCost, "Costo anual de mantener una unidad");
    const workingDays = number(input.workingDays ?? 360, "Días laborables");
    const leadTime = number(input.leadTime ?? 0, "Tiempo de entrega");
    const safetyStock = number(input.safetyStock ?? 0, "Inventario de seguridad");
    if (demand <= 0 || orderCost <= 0 || holdingCost <= 0 || workingDays <= 0) {
      throw new Error("Demanda, costo de pedido, costo de mantenimiento y días deben ser mayores que cero.");
    }
    if (leadTime < 0 || safetyStock < 0) throw new Error("Tiempo de entrega e inventario de seguridad no pueden ser negativos.");
    const eoq = Math.sqrt((2 * demand * orderCost) / holdingCost);
    const orders = demand / eoq;
    const cycleDays = workingDays / orders;
    const dailyDemand = demand / workingDays;
    const reorderPoint = dailyDemand * leadTime + safetyStock;
    const orderingCost = orders * orderCost;
    const annualHolding = (eoq / 2) * holdingCost;
    return {
      eoq: clean(eoq, 4),
      orders: clean(orders, 4),
      cycleDays: clean(cycleDays, 4),
      dailyDemand: clean(dailyDemand, 4),
      reorderPoint: clean(reorderPoint, 4),
      orderingCost: clean(orderingCost, 4),
      holdingCost: clean(annualHolding, 4),
      relevantCost: clean(orderingCost + annualHolding, 4),
    };
  }

  function parseMatrix(text) {
    const rows = String(text).trim().split(/\n+/).map((row) => row.trim()).filter(Boolean);
    if (!rows.length) throw new Error("La matriz está vacía.");
    const matrix = rows.map((row, i) => row.split(/[;,\s]+/).filter(Boolean).map((value, j) => number(value, `Fila ${i + 1}, columna ${j + 1}`)));
    const width = matrix[0].length;
    if (!width || matrix.some((row) => row.length !== width)) throw new Error("Todas las filas de la matriz deben tener la misma cantidad de valores.");
    return matrix;
  }

  function parseVector(text, label) {
    const values = String(text).trim().split(/[;,\s]+/).filter(Boolean).map((value, index) => number(value, `${label} ${index + 1}`));
    if (!values.length) throw new Error(`${label} está vacío.`);
    return values;
  }

  return {
    EPS,
    clean,
    constraintHolds,
    solveLinearProgram,
    solveSimplex,
    solveTransportation,
    solveAssignment,
    calculateEOQ,
    parseMatrix,
    parseVector,
  };
});
