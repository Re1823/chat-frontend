import { moneyMinor } from './browser-policy.mjs';

const id = value => String(value ?? '').trim();
const text = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Input is a small, allowlisted projection from the page, never the raw SSR payload.
export function normalizeTaobaoSsr(source, expectedItemId, selectedProperties = '') {
  if (id(source?.itemId) !== id(expectedItemId)) throw new Error('product_data_mismatch');
  if (!Array.isArray(source.props) || !Array.isArray(source.skus) || !source.info || typeof source.info !== 'object') throw new Error('product_data_unavailable');
  const dimensions = source.props.slice(0, 8).map(prop => ({
    pid: id(prop.pid), name: text(prop.name, 60),
    values: (Array.isArray(prop.values) ? prop.values : []).slice(0, 80).map(value => ({ vid: id(value.vid), name: text(value.name, 100) }))
  })).filter(prop => prop.pid && prop.values.length);
  const valueByPath = new Map(dimensions.flatMap(prop => prop.values.map(value => [`${prop.pid}:${value.vid}`, value.name])));
  const skuOptions = source.skus.slice(0, 200).flatMap(sku => {
    const skuId = id(sku.skuId), propPath = id(sku.propPath);
    const parts = propPath.split(';').filter(Boolean);
    if (!skuId || !parts.length || parts.some(part => !valueByPath.has(part))) return [];
    const detail = source.info[skuId];
    if (!detail) return [];
    let priceMinor = null;
    try { priceMinor = moneyMinor(detail.priceText); } catch { /* Price is not trustworthy. */ }
    const stock = detail.quantity !== null && detail.quantity !== undefined && Number.isSafeInteger(Number(detail.quantity)) && Number(detail.quantity) >= 0 ? Number(detail.quantity) : null;
    return [{ skuId, propPath, label: parts.map(part => valueByPath.get(part)).join(' / '), priceMinor, stock, saleable: detail.saleable === true || detail.saleable === false ? detail.saleable : null }];
  });
  if (!skuOptions.length) throw new Error('product_data_unavailable');
  const selectedParts = selectedProperties.split(';').filter(Boolean);
  const matching = selectedParts.length ? skuOptions.filter(sku => selectedParts.every(part => sku.propPath.split(';').includes(part))) : [];
  const selected = matching.length === 1 ? matching[0] : null;
  const availability = !selected ? 'unknown' : selected.saleable === false || selected.stock === 0 ? 'unavailable' : selected.saleable === true && selected.stock !== null && selected.stock > 0 ? 'available' : 'unknown';
  return { title: text(source.title), merchant: text(source.merchant, 80), dimensions, skuOptions, selectedSkuId: selected?.skuId || null, displayedPrice: selected?.priceMinor === null || !selected ? '' : `¥${(selected.priceMinor / 100).toFixed(2)}`, availability, offers: [] };
}

export function selectedPropertyPath(props, selectedNames) {
  if (!Array.isArray(props) || !Array.isArray(selectedNames) || props.length !== selectedNames.length) return '';
  const parts = props.map((prop, index) => {
    const name = text(selectedNames[index], 100);
    const values = Array.isArray(prop.values) ? prop.values : [];
    const matches = name ? values.filter(value => text(value.name, 100) === name) : [];
    return matches.length === 1 ? `${id(prop.pid)}:${id(matches[0].vid)}` : '';
  });
  return parts.every(Boolean) ? parts.join(';') : '';
}
