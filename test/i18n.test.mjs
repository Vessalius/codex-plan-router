import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { languageFrom, localizeMessage } from '../i18n.mjs';
import { HTML } from '../ui.mjs';

test('language preference recognizes Simplified Chinese and respects HTTP priority', () => {
  assert.equal(languageFrom('zh-CN, en;q=0.9'), 'zh');
  assert.equal(languageFrom('zh-CN;q=0.2, en-US;q=0.9'), 'en');
  assert.equal(languageFrom('fr-FR'), 'en');
  assert.equal(localizeMessage('模型列表查询失败（429）', 'en'), 'Model list request failed (HTTP 429).');
});

test('dashboard switches all static labels and remembers the choice', () => {
  const title = { dataset: { msg: 'title' } };
  const routing = { dataset: { msg: 'routing' } };
  const nodes = new Map();
  const stored = new Map();
  const document = {
    documentElement: {},
    querySelectorAll: () => [title, routing],
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {});
      return nodes.get(id);
    }
  };
  const context = {
    document,
    navigator: { language: 'zh-CN' },
    location: { hash: '' },
    history: { replaceState() {} },
    localStorage: {
      getItem: key => stored.get(key),
      setItem: (key, value) => stored.set(key, value),
    },
  };
  const script = HTML.split('<script>')[1].split('</script>')[0];
  vm.runInNewContext(script, { ...context });
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(routing.textContent, '请求分配');
  nodes.get('language').onchange({ target: { value: 'en' } });
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(title.textContent, 'Codex Plan Router');
  assert.equal(routing.textContent, 'Request routing');
  assert.equal(stored.get('routerLanguage'), 'en');
  vm.runInNewContext(script, { ...context });
  assert.equal(routing.textContent, 'Request routing');
});
