async function safeGet(api, path) {
  try {
    const res = await api.get(path);
    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    return [];
  }
}

function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function findCodigoInObject(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object') return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  for (const k of Object.keys(obj)) {
    if (/^codigo/i.test(k)) {
      const v = obj[k];
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
  }

  // procura recursiva
  for (const k of Object.keys(obj)) {
    try {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const nested = findCodigoInObject(v, seen);
        if (nested) return nested;
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * Carrega os registros das tabelas esperadas e retorna um objeto { NOME: CODIGO }
 * - api: instância axios (ou objeto com .get)
 * - options.suffixes: array de sufixos a procurar (ex: ['ens','out','produto']) — opcional
 */
async function loadCatalogFromApi(api, options = {}) {
  const suffixes = options.suffixes || ['ens', 'out', 'produto', 'prod'];

  // ajuste os endpoints conforme seu backend (a sua página React usa /cereais e /produtos)
  const [cereais, produtos] = await Promise.all([
    safeGet(api, '/ensacados'),
    safeGet(api, '/produtos'),
  ]);

  const all = [...cereais, ...produtos];
  const map = {}; // resultado: NOME_NORMALIZADO -> CODIGO

  for (const it of all) {
    // tenta extrair nome por várias chaves comuns
    const nomeRaw = it.Nome || it.Nome_ens || it.Nome_out || it.descricao || it.Nome_produto || it.nome || it.descricao_produto || '';
    const nome = normalizeName(nomeRaw);
    if (!nome) continue;

    // tenta extrair códigos usando padrões previsíveis
    let codigo = null;

    // 1) chaves explícitas com sufixo conhecido: Codigo_<sufixo>
    for (const s of suffixes) {
      const key1 = `Codigo_${s}`;
      const key2 = `Codigo${s ? '_' + s : ''}`; // só por segurança
      if (it[key1]) {
        codigo = String(it[key1]).trim();
        break;
      }
      if (it[key2]) {
        codigo = String(it[key2]).trim();
        break;
      }
    }

    // 2) chaves sem sufixo ou com variações (Codigo, codigo_produto, Codigo_prod)
    if (!codigo) {
      const candidates = ['Codigo', 'codigo', 'Codigo_produto', 'Codigo_prod', 'Codigo_outro', 'Codigo_out'];
      for (const c of candidates) {
        if (it[c]) {
          codigo = String(it[c]).trim();
          break;
        }
      }
    }

    // 3) busca recursiva em objetos caso não exista chave direta
    if (!codigo) {
      codigo = findCodigoInObject(it);
    }

    // 4) fallback: se não tiver código, podemos usar o Id original como base
    if (!codigo) {
      const rawId = it.Id ?? it.Id_ens ?? it.Id_out ?? it.id ?? '';
      if (rawId !== '') codigo = String(rawId);
    }

    // coloca no mapa; se já existir nome igual prefira códigos não-numéricos ou mais completos
    if (map[nome]) {
      // se já existe, tente não sobrescrever se o existente já tem um código válido
      // preferir manter se existente for mais descritivo
      if (!map[nome] && codigo) map[nome] = codigo;
    } else {
      map[nome] = codigo || '';
    }
  }

  // retorno no formato parecido com seu JSON: chaves originais (não normalizadas) também podem ser úteis
  // vamos gerar duas formas: mapNormalized (chave normalizada) e mapOriginalName (chave no formato original mais legível)
  const mapOriginalName = {};
  for (const it of all) {
    const nomeRaw = it.Nome || it.Nome_ens || it.Nome_out || it.descricao || it.Nome_produto || it.nome || '';
    const nome = normalizeName(nomeRaw);
    if (!nome) continue;
    const codigo = map[nome] || '';
    mapOriginalName[String(nomeRaw).trim()] = codigo;
  }

  return {
    byNormalizedName: map,
    byOriginalName: mapOriginalName,
  };
}

module.exports = {
  loadCatalogFromApi,
};
