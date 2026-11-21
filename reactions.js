import { avatarElement } from './avatars.js';

const choices = new Map([
  ['👍', 'Thumbs up'], ['❤️', 'Heart'], ['🔥', 'Fire'], ['😂', 'Laugh'], ['😮', 'Surprised'], ['👎', 'Thumbs down'],
]);

function emojiButton(emoji, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = emoji;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

export function reactionControls(messageId, chat, onPick) {
  const bar = document.createElement('div');
  bar.className = 'reaction-bar';
  const reactions = chat.reactions.get(messageId) ?? new Map();
  const own = reactions.get(chat.userId)?.emoji;
  const pick = (emoji) => onPick(messageId, own === emoji ? null : emoji);

  for (const [emoji, name] of choices) {
    const people = [...reactions.values()].filter((reaction) => reaction.emoji === emoji);
    if (!people.length) continue;
    const chip = emojiButton(emoji, `${name}, ${people.length} ${people.length === 1 ? 'reaction' : 'reactions'}`);
    chip.className = 'reaction-chip';
    chip.setAttribute('aria-pressed', String(own === emoji));
    if (people.length === 1) {
      const [person] = people;
      const label = chat.members.get(person.user_id) ?? 'Teammate';
      chip.title = `${name} by ${label}`;
      chip.append(avatarElement(label, person.avatar_url));
    } else {
      chip.append(` ${people.length}`);
    }
    chip.addEventListener('click', () => pick(emoji));
    bar.append(chip);
  }

  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.popover = 'auto';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Choose an emoji reaction');

  const add = emojiButton('☺+', 'Add reaction');
  add.className = 'reaction-add';
  add.popoverTargetElement = picker;
  picker.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    const { left, top, bottom } = add.getBoundingClientRect();
    picker.style.left = `${Math.max(6, Math.min(left, window.innerWidth - 244))}px`;
    picker.style.top = `${top >= 50 ? top - 46 : bottom + 4}px`;
  });
  for (const [emoji, name] of choices) {
    const button = emojiButton(emoji, name);
    button.setAttribute('aria-pressed', String(own === emoji));
    button.addEventListener('click', () => {
      picker.hidePopover();
      pick(emoji);
    });
    picker.append(button);
  }
  bar.append(add, picker);
  return bar;
}
