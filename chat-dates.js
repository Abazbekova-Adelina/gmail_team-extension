const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function localDay(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0')).join('-');
}

export function dayLabel(date) {
  return (date.getFullYear() === new Date().getFullYear() ? dayFormat : yearFormat).format(date);
}

export function timeLabel(date) {
  return timeFormat.format(date);
}
