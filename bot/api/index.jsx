import axios from "axios";

const api = axios.create({
  baseURL: "apitccsite-production-7d4b.up.railway.app",
});

export default api;
