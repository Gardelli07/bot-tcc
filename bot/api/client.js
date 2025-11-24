import axios from "axios";

const raw = process.env.API_BASE_URL || "apitccsite-production-7d4b.up.railway.app";
// garante que haja http/https; adiciona https:// se faltar
const baseURL = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

const api = axios.create({
  baseURL,
  timeout: 10000,
});

export default api;