// Envia lembretes de consulta pelo WhatsApp (CallMeBot).
// Roda no GitHub Actions a cada 30 minutos. Não precisa instalar nada (Node 20+).
//
// Segredos (GitHub › Settings › Secrets and variables › Actions):
//   SUPABASE_URL         https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY  chave "secret" (sb_secret_...) ou "service_role" do Supabase
//   WHATSAPP_CONTATOS    numero:apikey — vários separados por vírgula
//                        ex.: 5511999998888:123456, 5511977776666:654321

const AVISO_DIA_HORAS = 24;   // primeiro aviso: até 24h antes
const AVISO_PERTO_HORAS = 3;  // segundo aviso: até 3h antes
const FUSO = 'America/Sao_Paulo';

let SUPABASE_URL = '';
try { SUPABASE_URL = new URL((process.env.SUPABASE_URL || '').trim()).origin; }
catch { sair('O segredo SUPABASE_URL está vazio ou inválido (ex.: https://xxxx.supabase.co).'); }
const CHAVE = (process.env.SUPABASE_SECRET_KEY || '').trim();
const MODO_TESTE = process.env.MODO_TESTE === 'true';
const CALLMEBOT = process.env.CALLMEBOT_URL || 'https://api.callmebot.com/whatsapp.php';
const AGORA = process.env.AGORA ? new Date(process.env.AGORA) : new Date();

const CONTATOS = (process.env.WHATSAPP_CONTATOS || '')
  .split(/[,;\n]/)
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => {
    const [numero, apikey] = p.split(':').map((x) => (x || '').trim());
    return { numero: '+' + numero.replace(/\D/g, ''), apikey };
  })
  .filter((c) => c.numero.length > 8 && c.apikey);

if (!CHAVE) sair('Falta o segredo SUPABASE_SECRET_KEY.');
if (!CONTATOS.length) sair('Falta o segredo WHATSAPP_CONTATOS (formato numero:apikey).');

function sair(msg) {
  console.error('ERRO: ' + msg);
  process.exit(1);
}

// ---------- Supabase (REST) ----------
function cabecalhos(extra = {}) {
  const h = { apikey: CHAVE, 'Content-Type': 'application/json', ...extra };
  // chaves antigas (JWT) também precisam do Authorization; as novas (sb_secret_) não
  if (!CHAVE.startsWith('sb_')) h.Authorization = 'Bearer ' + CHAVE;
  return h;
}

async function buscarConsultas() {
  const ate = new Date(AGORA.getTime() + (AVISO_DIA_HORAS + 1) * 3600e3).toISOString();
  const url = SUPABASE_URL + '/rest/v1/consultas' +
    '?select=id,data_hora,especialidade,medico,local,telefone,observacoes,aviso_dia_enviado,aviso_horas_enviado' +
    '&status=eq.agendada' +
    '&data_hora=gt.' + encodeURIComponent(AGORA.toISOString()) +
    '&data_hora=lte.' + encodeURIComponent(ate) +
    '&order=data_hora.asc';
  const r = await fetch(url, { headers: cabecalhos() });
  if (!r.ok) sair('Supabase respondeu ' + r.status + ': ' + (await r.text()));
  return r.json();
}

async function marcar(id, campos) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/consultas?id=eq.' + id, {
    method: 'PATCH',
    headers: cabecalhos({ Prefer: 'return=minimal' }),
    body: JSON.stringify(campos),
  });
  if (!r.ok) console.error('Não consegui marcar a consulta ' + id + ': ' + r.status + ' ' + (await r.text()));
}

// ---------- datas em português ----------
const fmtData = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtSemana = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'long' });
const fmtDiaMes = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: 'numeric', month: 'long' });
const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });

function quandoTexto(d) {
  const hoje = fmtData.format(AGORA);
  const amanha = fmtData.format(new Date(AGORA.getTime() + 86400e3));
  const dia = fmtData.format(d);
  const prefixo = dia === hoje ? 'HOJE' : dia === amanha ? 'AMANHÃ' : fmtSemana.format(d);
  return (prefixo + ', ' + fmtDiaMes.format(d) + ', às ' + fmtHora.format(d)).toUpperCase();
}

function mensagem(c, tipo) {
  const d = new Date(c.data_hora);
  const linhas = [
    tipo === 'perto' ? '⏰ *SUA CONSULTA É DAQUI A POUCO*' : '🩺 *LEMBRETE DE CONSULTA*',
    '',
    '*' + quandoTexto(d) + '*',
    (c.especialidade || '').toUpperCase() + (c.medico ? ' — ' + c.medico.toUpperCase() : ''),
  ];
  if (c.local) linhas.push('📍 ' + c.local.toUpperCase());
  if (c.telefone) linhas.push('☎️ ' + c.telefone);
  if (c.observacoes) linhas.push('', '📝 ' + c.observacoes.toUpperCase());
  return linhas.join('\n');
}

// ---------- WhatsApp ----------
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviar(texto) {
  let algumOk = false;
  for (const c of CONTATOS) {
    const url = CALLMEBOT + '?phone=' + encodeURIComponent(c.numero) +
      '&text=' + encodeURIComponent(texto) + '&apikey=' + encodeURIComponent(c.apikey);
    try {
      const r = await fetch(url);
      const corpo = await r.text();
      const falhou = !r.ok || /error|invalid|not\s+activated|apikey\s+is\s+not/i.test(corpo);
      console.log((falhou ? '  ✗ ' : '  ✓ ') + c.numero.slice(0, 5) + '•••' + (falhou ? ' — ' + corpo.replace(/<[^>]+>/g, ' ').trim().slice(0, 200) : ''));
      if (!falhou) algumOk = true;
    } catch (e) {
      console.log('  ✗ ' + c.numero.slice(0, 5) + '••• — ' + e.message);
    }
    await espera(4000); // o CallMeBot não gosta de mensagens muito seguidas
  }
  return algumOk;
}

// ---------- principal ----------
async function principal() {
  if (MODO_TESTE) {
    console.log('Enviando mensagem de teste…');
    const ok = await enviar('✅ *TESTE DA AGENDA DE CONSULTAS*\n\nSE VOCÊ RECEBEU ESTA MENSAGEM, OS AVISOS ESTÃO FUNCIONANDO.');
    if (!ok) sair('Nenhuma mensagem de teste foi entregue.');
    return;
  }

  const consultas = await buscarConsultas();
  console.log(consultas.length + ' consulta(s) nas próximas ' + AVISO_DIA_HORAS + 'h.');

  for (const c of consultas) {
    const horas = (new Date(c.data_hora) - AGORA) / 3600e3;
    let tipo = null;
    if (!c.aviso_horas_enviado && horas <= AVISO_PERTO_HORAS) tipo = 'perto';
    else if (!c.aviso_dia_enviado && horas <= AVISO_DIA_HORAS && horas > AVISO_PERTO_HORAS) tipo = 'dia';
    if (!tipo) continue;

    console.log('Aviso "' + tipo + '": ' + c.especialidade + ' em ' + quandoTexto(new Date(c.data_hora)));
    const ok = await enviar(mensagem(c, tipo));
    if (!ok) continue; // tenta de novo na próxima rodada

    await marcar(c.id, tipo === 'perto'
      ? { aviso_horas_enviado: true, aviso_dia_enviado: true }
      : { aviso_dia_enviado: true });
  }
}

principal().catch((e) => sair(e.stack || e.message));
