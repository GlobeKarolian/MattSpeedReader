(async function () {
  const target = document.getElementById('stories');
  const lastUpdatedEl = document.getElementById('last-updated');

  async function getJSON(url) {
    const resp = await fetch(url + '?ts=' + Date.now());
    if (!resp.ok) throw new Error('Failed to load summaries.json');
    return resp.json();
  }

  function render(items) {
    if (!items?.length) {
      target.innerHTML = `<div class="empty">No stories yet. Check back shortly.</div>`;
      return;
    }
    const html = items.map(story => `
      <article class="card">
        <a href="${story.url}" target="_blank" rel="noopener">
          ${story.image ? `<img class="card-media" src="${story.image}" alt="">` : `<div class="card-media"></div>`}
        </a>
        <div class="card-body">
          <div class="kicker">${story.section || 'Top Stories'}</div>
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
    if (lastUpdatedEl) lastUpdatedEl.textContent = new Date().toLocaleString();
  }

  try {
    const data = await getJSON('data/summaries.json');
    render(data);
  } catch (err) {
    target.innerHTML = `<div class="empty">Couldn’t load stories. First run may still be generating.</div>`;
    console.error(err);
  }
})();