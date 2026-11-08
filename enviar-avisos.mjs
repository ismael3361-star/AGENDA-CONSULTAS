// Envia lembretes de consulta pelo app ntfy (notificação no celular) e/ou WhatsApp (CallMeBot).
// Roda no GitHub Actions a cada 30 minutos. Não precisa instalar nada (Node 20+).
//
// Segredos (GitHub › Settings › Secrets and variables › Actions):
//   SUPABASE_URL         https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY  chave "secret" (sb_secret_...) ou "service_role" do Supabase
//   NTFY_CANAL           nome do canal no app ntfy (ex.: agenda-consultas-k7p3x9)
//                        — ou dentro do WHATSAPP_CONTATOS como "ntfy:agenda-consultas-k7p3x9"
//   WHATSAPP_CONTATOS    (opcional) numero:apikey — vários separados por vírgula
//                        ex.: 5511999998888:123456, 5511977776666:654321
//   EMAIL_REMETENTE      conta Gmail que envia (ex.: agenda.familia@gmail.com)
//   EMAIL_SENHA_APP      senha de app do Google (16 letras) dessa conta
//   EMAIL_DESTINOS       e-mails que recebem, separados por vírgula
// Basta um canal (e-mail, WhatsApp ou ntfy) estar preenchido.

const AVISO_DIA_HORAS = 24;   // primeiro aviso: até 24h antes
const AVISO_PERTO_HORAS = 3;  // segundo aviso: até 3h antes
const FUSO = 'America/Sao_Paulo';

let SUPABASE_URL = '';
try { SUPABASE_URL = new URL((process.env.SUPABASE_URL || '').trim()).origin; }
catch { sair('O segredo SUPABASE_URL está vazio ou inválido (ex.: https://xxxx.supabase.co).'); }
const CHAVE = (process.env.SUPABASE_SECRET_KEY || '').trim();
const MODO_TESTE = process.env.MODO_TESTE === 'true';
const CALLMEBOT = process.env.CALLMEBOT_URL || 'https://api.callmebot.com/whatsapp.php';
const NTFY_SERVIDOR = process.env.NTFY_SERVIDOR || 'https://ntfy.sh';

const AGORA = process.env.AGORA ? new Date(process.env.AGORA) : new Date();

const PARTES = (process.env.WHATSAPP_CONTATOS || '')
  .split(/[,;\n]/)
  .map((p) => p.trim())
  .filter(Boolean);

// O canal do ntfy pode vir no segredo NTFY_CANAL ou dentro do WHATSAPP_CONTATOS como "ntfy:nome-do-canal"
const NTFY_CANAL = ((process.env.NTFY_CANAL || '').trim() ||
  (PARTES.find((p) => /^ntfy:/i.test(p)) || '').replace(/^ntfy:/i, '').trim())
  .replace(/^https?:\/\/[^/]+\//, '');

const EMAIL_REMETENTE = (process.env.EMAIL_REMETENTE || '').trim();
const EMAIL_SENHA_APP = (process.env.EMAIL_SENHA_APP || '').replace(/\s+/g, '');
const EMAIL_DESTINOS = (process.env.EMAIL_DESTINOS || '').split(/[,;\s]+/).map((e) => e.trim()).filter((e) => e.includes('@'));
const EMAIL_ATIVO = !!(EMAIL_REMETENTE && EMAIL_SENHA_APP && EMAIL_DESTINOS.length);

const CONTATOS = PARTES
  .filter((p) => !/^ntfy:/i.test(p))
  .map((p) => {
    const [numero, apikey] = p.split(':').map((x) => (x || '').trim());
    return { numero: '+' + numero.replace(/\D/g, ''), apikey };
  })
  .filter((c) => c.numero.length > 8 && c.apikey);

if (!CHAVE) sair('Falta o segredo SUPABASE_SECRET_KEY.');
if (!CONTATOS.length && !NTFY_CANAL && !EMAIL_ATIVO) sair('Nenhum canal configurado: preencha EMAIL_REMETENTE, EMAIL_SENHA_APP e EMAIL_DESTINOS (ou WHATSAPP_CONTATOS).');

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
    '?select=*' +
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
  const exame = c.tipo === 'exame';
  const linhas = [
    exame
      ? (tipo === 'perto' ? '⏰ *SEU EXAME É DAQUI A POUCO*' : '🧪 *LEMBRETE DE EXAME*')
      : (tipo === 'perto' ? '⏰ *SUA CONSULTA É DAQUI A POUCO*' : '🩺 *LEMBRETE DE CONSULTA*'),
    '',
    '*' + quandoTexto(d) + '*',
    (c.especialidade || '').toUpperCase() + (c.medico ? ' — ' + c.medico.toUpperCase() : ''),
  ];
  if (exame && c.jejum_horas) {
    const ini = new Date(d.getTime() - c.jejum_horas * 3600e3);
    linhas.push('', '⏳ *JEJUM DE ' + c.jejum_horas + ' HORAS: NÃO COMER DEPOIS DAS ' + fmtHora.format(ini) + ' (' + quandoTexto(ini).split(',')[0] + ')*');
  }
  if (c.local) linhas.push('📍 ' + c.local.toUpperCase());
  if (c.telefone) linhas.push('☎️ ' + c.telefone);
  if (c.observacoes) linhas.push('', '📝 ' + c.observacoes.toUpperCase());
  return linhas.join('\n');
}

// ---------- envio ----------
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviar(texto) {
  const emailOk = await enviarEmail(texto);
  const ntfyOk = await enviarNtfy(texto);
  const zapOk = await enviarWhatsApp(texto);
  return emailOk || ntfyOk || zapOk;
}

// E-mail pelo Gmail (senha de app)
let transporte = null;
async function enviarEmail(texto) {
  if (!EMAIL_ATIVO) return false;
  const linhas = texto.replace(/\*/g, '').split('\n');
  const titulo = linhas[0].trim();
  const corpo = linhas.slice(1).join('\n').trim();
  const assunto = titulo + ' — ' + (linhas.slice(1).find((l) => l.trim()) || '').trim();
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:22px;line-height:1.5;color:#111">' +
    '<p style="font-size:28px;font-weight:bold;margin:0 0 16px">' + esc(titulo) + '</p>' +
    corpo.split('\n').map((l, i) => '<p style="margin:0 0 8px' + (i === 0 ? ';font-weight:bold' : '') + '">' + (esc(l) || '&nbsp;') + '</p>').join('') +
    '</div>';
  try {
    if (!transporte) {
      const nodemailer = (await import('nodemailer')).default;
      transporte = process.env.EMAIL_TESTE_JSON
        ? nodemailer.createTransport({ jsonTransport: true })
        : nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA_APP } });
    }
    const info = await transporte.sendMail({
      from: { name: 'Agenda de Consultas', address: EMAIL_REMETENTE },
      to: EMAIL_DESTINOS.join(', '),
      subject: assunto,
      text: titulo + '\n\n' + corpo,
      html,
    });
    if (process.env.EMAIL_TESTE_JSON) console.error(info.message);
    console.log('  ✓ e-mail para ' + EMAIL_DESTINOS.length + ' destinatário(s)');
    return true;
  } catch (e) {
    let dica = '';
    if (/Invalid login|Username and Password not accepted|535/i.test(e.message)) dica = ' (confira EMAIL_REMETENTE e EMAIL_SENHA_APP: precisa ser a SENHA DE APP de 16 letras, não a senha normal)';
    console.log('  ✗ e-mail — ' + e.message.split('\n')[0] + dica);
    return false;
  }
}

// Notificação no app ntfy (grátis, iPhone e Android)
async function enviarNtfy(texto) {
  if (!NTFY_CANAL) return false;
  const limpo = texto.replace(/\*/g, '');
  const [titulo, ...resto] = limpo.split('\n');
  try {
    const r = await fetch(NTFY_SERVIDOR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: NTFY_CANAL,
        title: titulo.trim(),
        message: resto.join('\n').trim(),
        priority: 5, // máxima: toca som e aparece na tela
      }),
    });
    const ok = r.ok;
    console.log((ok ? '  ✓ ' : '  ✗ ') + 'ntfy' + (ok ? '' : ' — ' + r.status + ' ' + (await r.text()).slice(0, 200)));
    return ok;
  } catch (e) {
    console.log('  ✗ ntfy — ' + e.message);
    return false;
  }
}

// WhatsApp pelo CallMeBot
async function enviarWhatsApp(texto) {
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
