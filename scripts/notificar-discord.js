const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ARQUIVO_MEMORIA = path.join(__dirname, 'enviados.json');

if (!WEBHOOK_URL) {
  console.error('Erro: DISCORD_WEBHOOK_URL não configurado nos Secrets do GitHub.');
  process.exit(1);
}

// Lê a lista de episódios já enviados anteriormente
function lerEnviados() {
  try {
    if (!fs.existsSync(ARQUIVO_MEMORIA)) return [];
    const conteudo = fs.readFileSync(ARQUIVO_MEMORIA, 'utf8');
    const lista = JSON.parse(conteudo);
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

// Salva os últimos 300 episódios enviados
function salvarEnviados(lista) {
  const reduzida = lista.slice(-300);
  fs.writeFileSync(ARQUIVO_MEMORIA, JSON.stringify(reduzida, null, 2), 'utf8');
}

function limparTexto(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Coleta lançamentos recentes do AnimesBrasil
async function buscarAnimesBrasil() {
  const itens = [];
  try {
    const res = await fetch('https://animesbrasil.app/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return itens;
    const html = await res.text();

    const regex = /<a[^>]+href=["'](https:\/\/animesbrasil\.app\/episodio\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const vistos = new Set();

    while ((match = regex.exec(html)) !== null) {
      const url = match[1];
      if (vistos.has(url)) continue;
      vistos.add(url);

      const bloco = match[2];
      const imgMatch = bloco.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
      const capa = imgMatch ? imgMatch[1] : 'https://i.8upload.com/image/4784a42f992b726d/icos.png';
      const tituloLimpo = limparTexto(bloco) || url.split('/').pop().replace(/-/g, ' ');
      const dublado = /dublado/i.test(url) || /dublado/i.test(tituloLimpo);

      itens.push({
        id: url,
        titulo: tituloLimpo.slice(0, 120),
        audio: dublado ? 'Dublado' : 'Legendado',
        capa
      });

      if (itens.length >= 15) break;
    }
  } catch (err) {
    console.warn('Falha ao consultar AnimesBrasil:', err.message);
  }
  return itens;
}

// Coleta lançamentos recentes do Goyabu
async function buscarGoyabu() {
  const itens = [];
  try {
    const res = await fetch('https://goyabu.io/inicio', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return itens;
    const html = await res.text();

    const regex = /<a[^>]+href=["'](https:\/\/goyabu\.io\/\d+\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const vistos = new Set();

    while ((match = regex.exec(html)) !== null) {
      const url = match[1];
      if (vistos.has(url)) continue;
      vistos.add(url);

      const bloco = match[2];
      const imgMatch = bloco.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
      const capa = imgMatch ? imgMatch[1] : 'https://i.8upload.com/image/4784a42f992b726d/icos.png';
      const tituloLimpo = limparTexto(bloco);
      if (!tituloLimpo) continue;

      const dublado = /dublado/i.test(tituloLimpo);

      itens.push({
        id: url,
        titulo: tituloLimpo.slice(0, 120),
        audio: dublado ? 'Dublado' : 'Legendado',
        capa
      });

      if (itens.length >= 15) break;
    }
  } catch (err) {
    console.warn('Falha ao consultar Goyabu:', err.message);
  }
  return itens;
}

async function enviarParaDiscord(ep) {
  const payload = {
    username: 'Mega Animes',
    avatar_url: 'https://i.8upload.com/image/4784a42f992b726d/icos.png',
    embeds: [
      {
        author: {
          name: 'Mega Animes • Novo Episódio Disponível',
          icon_url: 'https://i.8upload.com/image/4784a42f992b726d/icos.png'
        },
        title: ep.titulo,
        description: `🎧 **Áudio:** ${ep.audio}\n📺 **Qualidade:** SD / HD / FHD\n📱 Já disponível para assistir no aplicativo **Mega Animes**!`,
        color: 15010068, // Vermelho #E50914
        thumbnail: {
          url: ep.capa.startsWith('http') ? ep.capa : 'https://i.8upload.com/image/4784a42f992b726d/icos.png'
        },
        footer: {
          text: 'Mega Animes • Baixe o app: carlin-dark.github.io/Mega-Anime'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.error('Erro ao enviar para o Discord:', res.status, await res.text());
  }
}

async function executar() {
  const enviados = lerEnviados();
  const setEnviados = new Set(enviados);

  const [listaAB, listaGoyabu] = await Promise.all([
    buscarAnimesBrasil(),
    buscarGoyabu()
  ]);

  const todos = [...listaAB, ...listaGoyabu];
  const novos = todos.filter((item) => !setEnviados.has(item.id));

  if (novos.length === 0) {
    console.log('Nenhum episódio novo encontrado agora.');
    return;
  }

  // Na primeira execução, se a memória estiver vazia, envia apenas os 5 mais recentes para não dar spam no canal
  const filaParaEnviar = enviados.length === 0 ? novos.slice(0, 5) : novos;

  for (const ep of filaParaEnviar) {
    await enviarParaDiscord(ep);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Marca todos os encontrados na memória para não duplicar
  for (const item of novos) {
    setEnviados.add(item.id);
  }

  salvarEnviados([...setEnviados]);
  console.log(`${filaParaEnviar.length} notificação(ões) enviada(s) ao Discord!`);
}

executar();
