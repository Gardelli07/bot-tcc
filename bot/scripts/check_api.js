import api from "../api/client.js";

const paths = [
  "/",
  "/produtos",
  "/ensacados",
  "/cereais",
  "/itens",
  "/produtos?limit=100",
  "/api/produtos",
  "/api/ensacados",
];

async function probe() {
  for (const p of paths) {
    try {
      const res = await api.get(p);
      const isArray = Array.isArray(res.data);
      console.log(p, "status=", res.status, "type=", isArray ? "array" : typeof res.data, "length=", isArray ? res.data.length : "-", "preview=", JSON.stringify(res.data).slice(0, 250));
    } catch (err) {
      if (err.response) {
        console.error(p, "-> HTTP", err.response.status, JSON.stringify(err.response.data).slice(0,200));
      } else {
        console.error(p, "-> error:", err.message);
      }
    }
  }
}

probe().catch((e)=>{ console.error("fatal:", e); process.exit(1); });