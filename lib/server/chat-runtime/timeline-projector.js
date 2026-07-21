'use strict';

function projectTimeline(events) {
  const order = [];
  const items = new Map();
  for (const event of events) applyEvent(order, items, event);
  return order.map((id) => items.get(id)).filter(Boolean);
}

function applyEvent(order, items, event) {
  if (event.type === 'timeline.item.delta') {
    appendDelta(items, event.payload.itemId, event.payload.chunk);
    return;
  }
  if (![
    'timeline.item.started',
    'timeline.item.updated',
    'timeline.item.completed'
  ].includes(event.type)) return;
  const item = structuredClone(event.payload.item);
  if (!items.has(item.id)) order.push(item.id);
  items.set(item.id, item);
}

function appendDelta(items, itemId, chunk) {
  const current = items.get(itemId);
  if (!current) return;
  items.set(itemId, {
    ...current,
    content: `${current.content || ''}${String(chunk || '')}`
  });
}

module.exports = { projectTimeline };
