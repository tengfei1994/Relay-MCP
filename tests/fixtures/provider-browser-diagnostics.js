async (page) => {
  await page.goto('http://127.0.0.1:19742/knowledge/integrated?tab=providers');
  await page.getByRole('textbox', { name: 'Provider ID', exact: true }).fill('diagnostics-only');
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('http://127.0.0.1:19743/models-unavailable');
  await page.getByRole('textbox', { name: 'API token', exact: true }).fill('e2e-provider-token');
  await page.getByRole('button', { name: 'Fetch models', exact: true }).click();
  const discovery = page.getByRole('alert').filter({ hasText: 'Model discovery failed (GET /models)' });
  await discovery.waitFor();
  if (!/Relay request ID: [a-f0-9-]{36}/.test(await discovery.innerText())) throw new Error('Discovery error lacks correlation ID');
  if (await page.getByRole('button', { name: 'Test and save', exact: true }).count()) throw new Error('Failed discovery allowed saving');
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('http://127.0.0.1:19743/embedding-unavailable');
  await page.getByRole('button', { name: 'Fetch models', exact: true }).click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-embedding');
  await page.getByRole('button', { name: 'Test and save', exact: true }).click();
  const embedding = page.getByRole('alert').filter({ hasText: 'Embedding failed (POST /embeddings)' });
  await embedding.waitFor();
  const message = await embedding.innerText();
  if (!message.includes('fixture-gateway-request-502') || !/Relay request ID: [a-f0-9-]{36}/.test(message)) throw new Error('Embedding error lacks correlation IDs');
  if (/e2e-provider-token|private gateway detail/.test(message)) throw new Error('Upstream secrets leaked into alert');
  if (await page.getByText('diagnostics-only · openai-compatible · fixture-embedding', { exact: true }).count()) throw new Error('Failed provider was saved');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: 'output/playwright/provider-diagnostics.png', fullPage: true });
  return { passed: true, checks: ['discovery stage', 'embedding stage', 'Relay and upstream IDs visible', 'private response body excluded', 'failed provider not saved'] };
}
