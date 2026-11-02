const REDIS_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const MAX_HISTORICO = 200;
const memoria = { ultima: null, historico: [] };

async function redis(comandos) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(comandos),
  });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  return r.json(); // [{result: ...}, ...]
}

async function salvar(registro) {
  if (!REDIS_URL) {
    memoria.ultima = registro;
    memoria.historico.unshift(registro);
    memoria.historico.length = Math.min(memoria.historico.length, MAX_HISTORICO);
    return;
  }
  const json = JSON.stringify(registro);
  await redis([
    ["SET", "telemetria:ultima", json],
    ["LPUSH", "telemetria:historico", json],
    ["LTRIM", "telemetria:historico", 0, MAX_HISTORICO - 1],
  ]);
}

async function ler(limit) {
  if (!REDIS_URL) {
    return { ultima: memoria.ultima, historico: memoria.historico.slice(0, limit) };
  }
  const [ultima, historico] = await redis([
    ["GET", "telemetria:ultima"],
    ["LRANGE", "telemetria:historico", 0, limit - 1],
  ]);
  return {
    ultima: ultima.result ? JSON.parse(ultima.result) : null,
    historico: (historico.result || []).map((s) => JSON.parse(s)),
  };
}

export default async function handler(req, res) {
  // CORS: permite o front (outro domínio ou localhost) consumir a API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "POST") {
      const b = req.body || {};
      const campos = ["velocidade", "distancia", "inclinacao_x"];
      const invalidos = campos.filter((c) => typeof b[c] !== "number" || !isFinite(b[c]));
      if (invalidos.length) {
        return res.status(400).json({ erro: "Campos inválidos", campos: invalidos });
      }

      const registro = {
        velocidade: b.velocidade,
        distancia: b.distancia,
        inclinacao_x: b.inclinacao_x,
        recebido_em: new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T") + "-03:00",
      };
      await salvar(registro);
      return res.status(201).json({ ok: true });
    }

    if (req.method === "GET") {
      const limit = Math.min(parseInt(req.query.limit) || 50, MAX_HISTORICO);
      return res.status(200).json(await ler(limit));
    }

    if (req.method === "DELETE") {
      if (!REDIS_URL) {
        memoria.ultima = null;
        memoria.historico = [];
        return res.status(200).json({ ok: true, msg: "Memória limpa" });
      }

        await redis([
        ["DEL", "telemetria:ultima"],
        ["DEL", "telemetria:historico"]
      ]);
      return res.status(200).json({ ok: true, msg: "Dados do Redis apagados" });
    }  

    return res.status(405).json({ erro: "Método não permitido" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Falha interna" });
  }
}
