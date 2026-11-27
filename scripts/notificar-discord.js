const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ARQUIVO_MEMORIA = path.join(__dirname, 'enviados.json');
const SITE_ALVO = 'https://animesonline.cloud';

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

// Salva os últimos 400 episódios enviados na memória
function salvarEnviados(lista) {
  const reduzida = lista.slice(-400);
  fs.writeFileSync(ARQUIVO_MEMORIA, JSON.stringify(reduzida, null, 2), 'utf8');
}

function limparTexto(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Coleta os episódios lançados na página inicial do Animes Online Cloud
async function buscarAnimesOnlineCloud() {
  const itens = [];
  try {
    const res = await fetch(`${SITE_ALVO}/`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml'
      }
    });

    if (!res.ok) {
      console.error('Falha HTTP ao acessar animesonline.cloud:', res.status);
      return itens;
    }

    const html = await res.text();
    const vistos = new Set();

    // Captura os links de episódios recentes na home (ex.: /episodio/... ou /episodios/...)
    const regexEpisodios =
      /<a[^>]+href=["'](https?:\/\/animesonline\.cloud\/(?:episodio|episodios)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = regexEpisodios.exec(html)) !== null) {
      const url = match[1].replace(/\/$/, '');
      if (vistos.has(url)) continue;

      const bloco = match[2];
      const imgMatch = bloco.match(/<img[^>]+(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i);
      const altMatch = bloco.match(/alt=["']([^"']+)["']/i);

      let tituloLimpo = limparTexto(bloco);
      if (!tituloLimpo && altMatch) {
        tituloLimpo = limparTexto(altMatch[1]);
      }
      if (!tituloLimpo) {
        tituloLimpo = decodeURIComponent(url.split('/').pop() || '').replace(/-/g, ' ');
      }

      // Ignora links genéricos de menu sem nome de anime/episódio
      if (!tituloLimpo || tituloLimpo.length < 3 || /^epis[oó]dios$/i.test(tituloLimpo)) {
        continue;
      }

      vistos.add(url);

      let capa = imgMatch ? imgMatch[1] : 'https://i.8upload.com/image/4784a42f992b726d/icos.png';
      if (capa.startsWith('//')) capa = `https:${capa}`;
      if (capa.startsWith('/')) capa = `${SITE_ALVO}${capa}`;

      const dublado = /dublado/i.test(url) || /dublado/i.test(tituloLimpo);

      itens.push({
        id: url,
        titulo: tituloLimpo.slice(0, 140),
        audio: dublado ? 'Dublado' : 'Legendado',
        capa
      });

      if (itens.length >= 20) break;
    }
  } catch (err) {
    console.error('Erro ao consultar animesonline.cloud:', err.message);
  }

  return itens;
}

async function enviarParaDiscord(ep, mencionarEveryone) {
  const payload = {
    username: 'Mega Animes',
    avatar_url: 'https://i.8upload.com/image/4784a42f992b726d/icos.png',
    // Menciona @everyone apenas na primeira mensagem do lote para não dar vários pings seguidos
    content: mencionarEveryone ? '@everyone Novo episódio chegou no **Mega Animes**!' : undefined,
    allowed_mentions: mencionarEveryone ? { parse: ['everyone'] } : { parse: [] },
    embeds: [
      {
        author: {
          name: 'Mega Animes • Atualização da Noite',
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

  const listaAtual = await buscarAnimesOnlineCloud();
  const novos = listaAtual.filter((item) => !setEnviados.has(item.id));

  if (novos.length === 0) {
    console.log('Nenhum episódio novo encontrado no animesonline.cloud hoje.');
    return;
  }

  // Na primeira execução com memória vazia, envia os 5 mais recentes para evitar spam no canal
  const filaParaEnviar = enviados.length === 0 ? novos.slice(0, 5) : novos;

  for (let i = 0; i < filaParaEnviar.length; i++) {
    const ep = filaParaEnviar[i];
    await enviarParaDiscord(ep, i === 0);
    await new Promise((r) => setTimeout(r, 1500));
  }

  for (const item of novos) {
    setEnviados.add(item.id);
  }

  salvarEnviados([...setEnviados]);
  console.log(`${filaParaEnviar.length} episódio(s) notificado(s) no Discord!`);
}

executar();
