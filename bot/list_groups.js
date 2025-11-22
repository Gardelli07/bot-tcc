// list_groups.js
// Lista grupos da sessão whatsapp-web.js e procura por "duvid" no nome
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true } // true para rodar em servidor, false para abrir janela (opcional)
});

client.on('qr', qr => {
  console.log('\n--- Escaneie o QR code com o WhatsApp (use o mesmo número do seu bot) ---\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  try {
    console.log('✅ Client pronto — buscando chats...');
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);

    if (groups.length === 0) {
      console.log('⚠️ Nenhum grupo encontrado nesta sessão.');
    } else {
      console.log(`\n📚 Foram encontrados ${groups.length} grupos:\n`);
      groups.forEach((g, idx) => {
        // Alguns campos podem não existir em versões diferentes; usamos safe-access
        const name = g.name || '(sem nome)';
        const id = g.id && g.id._serialized ? g.id._serialized : (g.id || '(sem id)');
        const participantsCount = (g.participants && g.participants.length) || '(desconhecido)';
        console.log(`${String(idx+1).padStart(2, ' ')} - ${name}`);
        console.log(`     id: ${id}`);
        console.log(`     participantes: ${participantsCount}\n`);
      });

      // busca por "duvid" no nome
      const needle = 'duvid';
      const matches = groups.filter(g => (g.name || '').toLowerCase().includes(needle));
      if (matches.length) {
        console.log(`🔎 Grupos com "${needle}" no nome (${matches.length}):`);
        matches.forEach(g => {
          const name = g.name || '(sem nome)';
          const id = g.id && g.id._serialized ? g.id._serialized : (g.id || '(sem id)');
          console.log(` - ${name} -> ${id}`);
        });
      } else {
        console.log(`🔎 Nenhum grupo com "${needle}" encontrado no nome.`);
      }
    }
  } catch (err) {
    console.error('Erro ao listar grupos:', err && err.message ? err.message : err);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.on('auth_failure', (msg) => {
  console.error('Falha na autenticação:', msg);
});

client.initialize().catch(e => {
  console.error('Falha ao inicializar client:', e && e.message ? e.message : e);
});
