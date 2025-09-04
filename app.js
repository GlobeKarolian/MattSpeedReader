(async function () {
  const target = document.getElementById('stories');
  const lastUpdatedEl = document.getElementById('last-updated');

  async function getJSON(url) {
    const resp = await fetch(url + '?ts=' + Date.now());
    if (!resp.ok) throw new Error('Failed to load summaries.json');
    return resp.json();
  }

  function humanTime(date) {
    if (!date) return 'just now';
    const d = new Date(date);
    const diffMs = Date.now() - d.getTime();
    const min = Math.max(0, Math.floor(diffMs / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const opts = { hour: 'numeric', minute: '2-digit' };
    const sameDay = new Date().toDateString() === d.toDateString();
    return (sameDay ? 'today ' : '') + d.toLocaleTimeString([], opts);
  }

  function render(items) {
    if (!items?.length) {
      target.innerHTML = `<div class="empty">No stories yet. Check back shortly.</div>`;
      if (lastUpdatedEl) lastUpdatedEl.textContent = 'just now';
      return;
    }

    // last updated = max published time we have
    const maxTime = items
      .map(s => s.published ? new Date(s.published).getTime() : 0)
      .reduce((a,b) => Math.max(a,b), 0);
    if (lastUpdatedEl) lastUpdatedEl.textContent = humanTime(maxTime);

    const html = items.map(story => `
      <article class="card">
        <a href="${story.url}" target="_blank" rel="noopener">
          ${story.image ? `<img class="card-media" src="${story.image}" alt="">` : `<div class="card-media"></div>`}
        </a>
        <div class="card-body">
          <div class="kicker">${story.section || 'News'}</div>
          <h2 class="title"><a href="${story.url}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">${story.title}</a></h2>
          <div class="meta">
            ${story.author ? `${story.author} · ` : ''}${story.published ? new Date(story.published).toLocaleString() : ''}
          </div>
          <ul class="bullets">
            ${story.bullets.map(b => `<li>${b}</li>`).join('')}
          </ul>
          <a class="read-more" href="${story.url}" target="_blank" rel="noopener" aria-label="Read the full article on Boston.com">Read on Boston.com</a>
        </div>
      </article>
    `).join('');

    target.innerHTML = html;
  }

  try {
    const data = await getJSON('data/summaries.json');
    render(data);
  } catch (err) {
    target.innerHTML = `<div class="empty">Couldn’t load stories. First run may still be generating.</div>`;
    if (lastUpdatedEl) lastUpdatedEl.textContent = '—';
    console.error(err);
  }
})();
