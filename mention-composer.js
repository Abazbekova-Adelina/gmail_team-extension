import { encodeMentions, mentionQuery, mentionToken } from './mentions.js';

export function mountMentions(input, getChat) {
  const list = document.querySelector('#mention-suggestions');
  const status = document.querySelector('#mention-status');
  let matches = [];
  let active = 0;
  let query;

  function hide() {
    list.hidden = true;
    input.removeAttribute('aria-activedescendant');
  }

  function select(index) {
    active = index;
    const options = [...list.children];
    options.forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', options[active].id);
    options[active].scrollIntoView({ block: 'nearest' });
  }

  function update({ suggestions = true } = {}) {
    hide();
    const chat = getChat();
    status.textContent = '';
    if (!chat || !input.value) return;

    const encoded = encodeMentions(input.value, chat.members, chat.userId);
    const ids = new Set([...encoded.matchAll(mentionToken)].map((match) => match[1].toLowerCase()));
    const names = [...ids].map((id) => chat.members.get(id)).filter(Boolean);
    if (names.length) status.textContent = `Mentioning ${names.join(', ')}`;
    if (!suggestions || input.readOnly || input.selectionStart !== input.selectionEnd) return;

    query = mentionQuery(input.value, input.selectionStart);
    if (!query) return;
    const prefix = query.query;
    matches = [...chat.members].filter(([id, name]) => id !== chat.userId && name.toLowerCase().startsWith(prefix)).slice(0, 6);
    if (!matches.length) {
      if (!names.length) status.textContent = prefix ? 'No matching teammates.' : 'No teammates to mention.';
      return;
    }
    list.replaceChildren(...matches.map(([, name], index) => {
      const option = document.createElement('li');
      option.id = `mention-suggestion-${index}`;
      option.setAttribute('role', 'option');
      option.textContent = name;
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => choose(index));
      return option;
    }));
    list.hidden = false;
    select(0);
  }

  function choose(index) {
    const name = matches[index][1];
    const tail = input.value.slice(input.selectionEnd).match(/^[\p{L}\p{M}\p{N}_-]*/u)[0];
    input.setRangeText(`@${name} `, query.start, input.selectionEnd + tail.length, 'end');
    input.focus();
    update({ suggestions: false });
  }

  input.addEventListener('input', () => update());
  input.addEventListener('click', () => update());
  input.addEventListener('blur', hide);
  input.addEventListener('keydown', (event) => {
    if (list.hidden || event.ctrlKey || event.metaKey || event.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        select((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        break;
      case 'Enter':
        if (event.shiftKey) return;
        event.preventDefault();
        choose(active);
        break;
      case 'Escape':
        event.preventDefault();
        hide();
        break;
    }
  });

  return () => update({ suggestions: false });
}
