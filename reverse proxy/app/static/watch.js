const PLAYER_CFG = JSON.parse(document.getElementById('vault-player-cfg').textContent);
const ANILIST_ID = Number(PLAYER_CFG.anilistId);
let currentProvider = 'megaplay';
let currentCategory = 'sub';
let animeData = null;

const placeholder = document.getElementById('placeholder');
const playerInfo = document.getElementById('playerInfo');
const currentEpNum = document.getElementById('currentEpNum');
const currentEpTitle = document.getElementById('currentEpTitle');
const episodeList = document.getElementById('episodeList');
const providerBar = document.getElementById('providerBar');
const epCount = document.getElementById('epCount');
const megaplayFrame = document.getElementById('megaplayFrame');

async function loadAnime() {
  try {
    const res = await fetch(`/api/anime/${ANILIST_ID}`);
    const data = await res.json();
    renderHeader(data.info);
    animeData = data.info;
  } catch(e) {
    console.error('Failed to load anime:', e);
  }
}

function renderHeader(info) {
  const header = document.getElementById('animeHeader');
  const title = info.title?.english || info.title?.romaji || 'Unknown';
  const native = info.title?.native || '';
  const banner = info.bannerImage || info.coverImage?.extraLarge || info.coverImage?.large;
  const poster = info.coverImage?.large || '';
  const genres = info.genres || [];
  const score = info.averageScore || info.meanScore;
  const seasonYear = info.seasonYear || '';
  const format = info.format || '';
  const episodes = info.episodes || (info.nextAiringEpisode?.episode ?? '?');

  document.title = `VaultCeaser - ${title}`;

  header.innerHTML = `
    <div class="backdrop">
      <img src="${banner || poster}" alt="" onerror="this.style.display='none'">
      <div class="overlay"></div>
    </div>
    <div class="title-row">
      <img class="poster" src="${poster}" alt="${title}" onerror="this.style.display='none'">
      <div class="info">
        <h1>${title}</h1>
        <div class="subtitle">${native}</div>
        <div class="meta">
          ${score ? `<span class="score">★ ${score}%</span>` : ''}
          ${format ? `<span>${format}</span>` : ''}
          ${seasonYear ? `<span>${seasonYear}</span>` : ''}
          <span>${episodes} ep</span>
          ${genres.slice(0,3).map(g => `<span>${g}</span>`).join('')}
        </div>
      </div>
    </div>
  `;
}

async function loadEpisodes() {
  try {
    const res = await fetch(`/api/anime/${ANILIST_ID}/episodes`);
    const data = await res.json();
    const providers = data.episodes?.providers || {};
    renderProviderBar();
    renderEpisodesForProvider(currentProvider, currentCategory, providers);
    return providers;
  } catch(e) {
    console.error('Failed to load episodes:', e);
    return {};
  }
}

async function renderEpisodesForProvider(provider, category, providers) {
  const pData = providers[provider];
  if (!pData) {
    episodeList.innerHTML = '<p style="color:var(--text2);padding:20px">No Megaplay (bee) episode list for this title.</p>';
    epCount.textContent = '';
    return;
  }
  const eps = pData.episodes?.[category] || [];
  epCount.textContent = `(${eps.length})`;

  episodeList.innerHTML = eps.map(ep => `
    <div class="episode-item" data-id="${ep.original_id || ep.id}" data-number="${ep.number}" data-title="${(ep.title || '').replace(/"/g,'&quot;')}" data-image="${ep.image || ''}" data-desc="${(ep.description || '').replace(/"/g,'&quot;')}" data-air="${ep.airDate || ''}">
      <img class="thumb" src="${ep.image || ''}" alt="" onerror="this.style.background='var(--surface2)'">
      <div class="ep-info">
        <div class="ep-number">EPISODE ${ep.number}</div>
        <div class="ep-name">${ep.title || `Episode ${ep.number}`}</div>
        <div class="ep-desc">${(ep.description || '').substring(0,100)}</div>
        <div class="ep-air">${ep.airDate || ''}</div>
      </div>
      <div class="loading-indicator"></div>
    </div>
  `).join('');

  document.querySelectorAll('.episode-item').forEach(el => {
    el.addEventListener('click', () => { playEpisode(el).catch((e) => console.error(e)); });
  });
}

function renderProviderBar() {
  const cats = ['sub', 'dub', 'ssub'];
  providerBar.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;width:100%;align-items:center">
      <span class="mp-label">PLAYBACK</span>
      <div style="display:flex;gap:4px;margin-left:auto;">
        ${cats.map(c => `<button type="button" class="cat-btn ${c === currentCategory ? 'active' : ''}" data-cat="${c}">${c.toUpperCase()}</button>`).join('')}
      </div>
    </div>
  `;

  providerBar.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      providerBar.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = btn.dataset.cat;
      megaplayFrame.src = 'about:blank';
      megaplayFrame.style.display = 'none';
      placeholder.style.display = 'block';
      playerInfo.style.display = 'none';
      await refreshEpisodes();
    });
  });
}

async function refreshEpisodes() {
  const res = await fetch(`/api/anime/${ANILIST_ID}/episodes`);
  const data = await res.json();
  renderProviderBar();
  renderEpisodesForProvider(currentProvider, currentCategory, data.episodes?.providers || {});
}

async function resolveMegaplayNumericStreamId(episodeId, category) {
  if (/^\d+$/.test(episodeId)) return episodeId;
  try {
    const qs = new URLSearchParams({ id: episodeId, aid: String(ANILIST_ID), category });
    const r = await fetch('/api/mp/stream/getSources?' + qs.toString());
    if (!r.ok) return null;
    const blob = JSON.stringify(await r.json());
    const m = blob.match(/stream\/s-2\/(\d+)\//);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

async function playEpisode(el) {
  const episodeId = el.dataset.id;
  const number = el.dataset.number;
  const title = el.dataset.title || `Episode ${number}`;

  document.querySelectorAll('.episode-item').forEach(e => e.classList.remove('active'));
  el.classList.add('active');

  currentEpNum.textContent = `EP ${number}`;
  currentEpTitle.textContent = title;
  playerInfo.style.display = 'flex';

  el.classList.add('loading');

  placeholder.style.display = 'none';
  megaplayFrame.style.display = 'block';
  const eidProxied = encodeURIComponent(episodeId);
  const aidQ = 'aid=' + ANILIST_ID;
  let src;
  if (PLAYER_CFG.embedS2Mode === 'upstream' && /^\d+$/.test(episodeId)) {
    src = PLAYER_CFG.megaplayOrigin + '/stream/s-2/' + encodeURI(episodeId) + '/' + currentCategory + '?' + aidQ;
  } else if (PLAYER_CFG.embedS2Mode === 'upstream') {
    const nid = await resolveMegaplayNumericStreamId(episodeId, currentCategory);
    if (nid) {
      src = PLAYER_CFG.megaplayOrigin + '/stream/s-2/' + nid + '/' + currentCategory + '?' + aidQ;
    } else {
      src = '/api/mp/stream/s-2/' + eidProxied + '/' + currentCategory + '?' + aidQ;
    }
  } else {
    src = '/api/mp/stream/s-2/' + eidProxied + '/' + currentCategory + '?' + aidQ;
  }
  megaplayFrame.src = src;

  el.classList.remove('loading');
}

loadAnime();
loadEpisodes();
