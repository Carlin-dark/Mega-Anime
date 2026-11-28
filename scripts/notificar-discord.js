const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ARQUIVO_MEMORIA = path.join(__dirname, 'enviados.json');
const SITE_ALVO = 'https://animesonline.cloud';
const CAPA_FALLBACK = 'https://i.8upload.com/image/4784a42f992b726d/icos.png';

const HEADERS_PADRAO = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
};

if (!WEBHOOK_URL) {
  console.error('Erro: DISCORD_WEBHOOK_URL não configurado nos Secrets do GitHub.');
  process.exit(1);
}

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

function salvarEnviados(lista) {
  const reduzida = lista.slice(-400);
  fs.writeFileSync(ARQUIVO_MEMORIA, JSON.stringify(reduzida, null, 2), 'utf8');
}

function limparTexto(html) {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, '-')
    .replace(/&#8217;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarUrl(link) {
  if (!link) return '';
  let u = link.trim();
  if (!u || u.startsWith('data:')) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  else if (u.startsWith('/')) u = `${SITE_ALVO}${u}`;
  return u.replace(/\/$/, '');
}

function ehImagemValida(url) {
  if (!url) return false;
  if (!url.startsWith('http')) return false;
  if (url.startsWith('data:')) return false;
  if (url === CAPA_FALLBACK) return false;
  if (/logo|Icone\.png|play1\.svg|blank\.gif|placeholder/i.test(url)) return false;
  return true;
}

// Extrai a melhor URL real de uma tag <img ...> ignorando placeholders lazy-load
function extrairCapaDeHtml(trechoHtml) {
  if (!trechoHtml) return '';

  const atributos = ['data-src', 'data-lazy-src', 'data-original', 'data-bg', 'src'];
  for (const attr of atributos) {
    const regex = new RegExp(`<img[^>]+\\b${attr}=["']([^"']+)["']`, 'i');
    const match = trechoHtml.match(regex);
    if (match && match[1]) {
      const candidata = normalizarUrl(match[1]);
      if (ehImagemValida(candidata)) return candidata;
    }
  }

  // Tenta extrair a primeira URL de srcset / data-srcset
  const srcsetMatch = trechoHtml.match(/<img[^>]+(?:data-srcset|srcset)=["']([^"']+)["']/i);
  if (srcsetMatch && srcsetMatch[1]) {
    const primeira = srcsetMatch[1].split(',')[0].trim().split(/\s+/)[0];
    const candidata = normalizarUrl(primeira);
    if (ehImagemValida(candidata)) return candidata;
  }

  return '';
}

// Busca a capa real diretamente dentro da página do episódio (og:image / twitter:image / pôster)
async function buscarCapaDaPaginaEpisodio(urlEpisodio) {
  try {
    const res = await fetch(urlEpisodio, { headers: HEADERS_PADRAO });
    if (!res.ok) return '';
    const html = await res.text();

    const metaPatterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
    ];

    for (const pattern of metaPatterns) {
      const m = html.match(pattern);
      if (m && m[1]) {
        const candidata = normalizarUrl(m[1]);
        if (ehImagemValida(candidata)) return candidata;
      }
    }

    // Fallback: procura imagem do pôster/capa dentro da página do episódio
    const posterArea = html.match(/<div[^>]*class=["'][^"']*(?:poster|thumb|sheader|imagen)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (posterArea) {
      const imgPoster = extrairCapaDeHtml(posterArea[1]);
      if (ehImagemValida(imgPoster)) return imgPoster;
    }

    // Fallback geral: primeira imagem de /wp-content/uploads/ ou CDN do site
    const uploadMatch = html.match(/https?:\/\/[^"'\s>]+\/wp-content\/uploads\/[^"'\s>]+\.(?:jpg|jpeg|png|webp)/i);
    if (uploadMatch && ehImagemValida(uploadMatch[0])) {
      return uploadMatch[0];
    }
  } catch {
    // ignora falha pontual
  }
  return '';
}

// 1. Lê os blocos <article class="... episodes"> da página inicial do tema DooPlay
async function buscarDaHomeDooPlay() {
  const itens = [];
  const res = await fetch(`${SITE_ALVO}/`, { headers: HEADERS_PADRAO });

  console.log('Status HTTP Home:', res.status);
  if (!res.ok) return itens;

  const html = await res.text();
  console.log('Tamanho HTML recebido:', html.length);

  const vistos = new Set();

  // Captura cada card <article ... class="... episodes ...">
  const regexArticles = /<article[^>]*class=["'][^"']*\bepisodes\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = regexArticles.exec(html)) !== null) {
    const card = match[1];
    const linkMatch = card.match(/<a[^>]+href=["']([^"']+)["']/i);
    if (!linkMatch) continue;

    const url = normalizarUrl(linkMatch[1]);
    if (!url || vistos.has(url)) continue;
    vistos.add(url);

    const h3Match = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const h4Match = card.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const spanMatch = card.match(/<div[^>]*class=["'][^"']*data[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);

    const tituloAnime = h3Match ? limparTexto(h3Match[1]) : '';
    const subTitulo = h4Match ? limparTexto(h4Match[1]) : spanMatch ? limparTexto(spanMatch[1]) : '';

    let tituloFinal = [tituloAnime, subTitulo].filter(Boolean).join(' — ');
    if (!tituloFinal) {
      tituloFinal = decodeURIComponent(url.split('/').pop() || '').replace(/-/g, ' ');
    }

    const capa = extrairCapaDeHtml(card);
    const dublado = /dublado/i.test(url) || /dublado/i.test(tituloFinal);

    itens.push({
      id: url,
      titulo: tituloFinal.slice(0, 150),
      audio: dublado ? 'Dublado' : 'Legendado',
      capa
    });
  }

  // Fallback dentro do próprio HTML caso os links estejam fora de <article class="episodes">
  if (itens.length === 0) {
    const regexLinks = /<a[^>]+href=["']((?:https?:\/\/animesonline\.cloud)?\/(?:episodio|episodios|episode)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = regexLinks.exec(html)) !== null) {
      const url = normalizarUrl(match[1]);
      if (!url || vistos.has(url)) continue;

      const texto = limparTexto(match[2]);
      if (!texto || texto.length < 3 || /^epis[oó]dios$/i.test(texto)) continue;

      vistos.add(url);
      itens.push({
        id: url,
        titulo: texto.slice(0, 150),
        audio: /dublado/i.test(url) || /dublado/i.test(texto) ? 'Dublado' : 'Legendado',
        capa: extrairCapaDeHtml(match[2])
      });
    }
  }

  return itens;
}

// 2. Backup via Feed RSS do WordPress (/feed/ ou /episodio/feed/)
async function buscarDoFeed() {
  const itens = [];
  const urlsFeed = [`${SITE_ALVO}/episodio/feed/`, `${SITE_ALVO}/episodios/feed/`, `${SITE_ALVO}/feed/`];

  for (const feedUrl of urlsFeed) {
    try {
      const res = await fetch(feedUrl, { headers: HEADERS_PADRAO });
      if (!res.ok) continue;

      const xml = await res.text();
      const regexItem = /<item>([\s\S]*?)<\/item>/gi;
      let m;
      while ((m = regexItem.exec(xml)) !== null) {
        const bloco = m[1];
        const titleM = bloco.match(/<title>([\s\S]*?)<\/title>/i);
        const linkM = bloco.match(/<link>([\s\S]*?)<\/link>/i);
        const mediaM = bloco.match(/<(?:media:content|media:thumbnail|enclosure)[^>]+url=["']([^"']+)["']/i);

        const url = normalizarUrl(linkM ? limparTexto(linkM[1]) : '');
        const titulo = titleM ? limparTexto(titleM[1]) : '';
        if (!url || !titulo) continue;

        let capa = normalizarUrl(mediaM ? mediaM[1] : '');
        if (!ehImagemValida(capa)) {
          capa = extrairCapaDeHtml(bloco);
        }

        itens.push({
          id: url,
          titulo: titulo.slice(0, 150),
          audio: /dublado/i.test(url) || /dublado/i.test(titulo) ? 'Dublado' : 'Legendado',
          capa
        });
      }

      if (itens.length > 0) {
        console.log(`Episódios encontrados via feed (${feedUrl}):`, itens.length);
        break;
      }
    } catch {
      // tenta o próximo feed
    }
  }

  return itens;
}

async function enviarParaDiscord(ep, mencionarEveryone) {
  const imagemFinal = ehImagemValida(ep.capa) ? ep.capa : CAPA_FALLBACK;

  const embed = {
    author: {
      name: 'Mega Animes • Atualização da Noite',
      icon_url: CAPA_FALLBACK
    },
    title: ep.titulo,
    description: `🎧 **Áudio:** ${ep.audio}\n📺 **Qualidade:** SD / HD / FHD\n📱 Já disponível para assistir no aplicativo **Mega Animes**!`,
    color: 15010068,
    footer: {
      text: 'Mega Animes • Baixe o app: carlin-dark.github.io/Mega-Anime'
    },
    timestamp: new Date().toISOString()
  };

  // Se encontrou a capa real do episódio, exibe em destaque no card (image + thumbnail)
  if (imagemFinal !== CAPA_FALLBACK) {
    embed.image = { url: imagemFinal };
    embed.thumbnail = { url: imagemFinal };
  } else {
    embed.thumbnail = { url: CAPA_FALLBACK };
  }

  const payload = {
    username: 'Mega Animes',
    avatar_url: CAPA_FALLBACK,
    content: mencionarEveryone ? '@everyone Novo episódio chegou no **Mega Animes**!' : undefined,
    allowed_mentions: mencionarEveryone ? { parse: ['everyone'] } : { parse: [] },
    embeds: [embed]
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

  let listaAtual = await buscarDaHomeDooPlay();
  if (listaAtual.length === 0) {
    console.log('Nenhum card encontrado na Home, tentando Feed RSS...');
    listaAtual = await buscarDoFeed();
  }

  console.log('Total de episódios coletados:', listaAtual.length);

  const novos = listaAtual.filter((item) => !setEnviados.has(item.id));

  if (novos.length === 0) {
    console.log('Nenhum episódio novo encontrado no animesonline.cloud hoje.');
    return;
  }

  const filaParaEnviar = enviados.length === 0 ? novos.slice(0, 5) : novos;

  for (let i = 0; i < filaParaEnviar.length; i++) {
    const ep = filaParaEnviar[i];

    // Se a capa ainda não veio válida no card/feed, busca direto na página do episódio
    if (!ehImagemValida(ep.capa)) {
      console.log(`Buscando capa real na página do episódio: ${ep.id}`);
      const capaPagina = await buscarCapaDaPaginaEpisodio(ep.id);
      if (ehImagemValida(capaPagina)) {
        ep.capa = capaPagina;
      }
    }

    console.log(`Enviando: ${ep.titulo} | Capa: ${ep.capa || 'fallback'}`);
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
