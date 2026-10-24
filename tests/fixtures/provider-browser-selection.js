async (page) => {
  await page.getByRole('textbox', {name:'Search models', exact:true}).fill('embedding');
  const model = page.getByRole('combobox', {name:'Model', exact:true});
  if ((await model.locator('option').count()) !== 2) throw new Error('Model filtering failed');
  await model.selectOption('fixture-embedding');
  await page.getByRole('textbox', {name:'Base URL', exact:true}).fill('http://127.0.0.1:19743/v1');
  if (await page.getByRole('button', {name:'Test and save', exact:true}).count()) throw new Error('Changed connection retained stale selection');
  await page.getByRole('button', {name:'Fetch models', exact:true}).click();
  await model.waitFor();
  await model.selectOption('fixture-embedding');
  await page.setViewportSize({width:1280,height:1000});
  await page.screenshot({path:'output/playwright/provider-model-selection.png',fullPage:true});
  await page.getByRole('button', {name:'Test and save', exact:true}).click();
  await page.getByText('Provider tested and saved. Detected 3 dimensions.', {exact:true}).waitFor();
  if (await page.getByRole('textbox', {name:'API token', exact:true}).inputValue()) throw new Error('Token retained in form');
  await page.reload();
  await page.getByText('browser-embedding · openai-compatible · fixture-embedding', {exact:true}).waitFor();
  await page.getByRole('button', {name:'Test', exact:true}).click();
  await page.getByText(/Probe ok/).waitFor();
  const leaked = await page.evaluate(() => JSON.stringify(localStorage).includes('e2e-provider-token') || JSON.stringify(sessionStorage).includes('e2e-provider-token'));
  if (leaked) throw new Error('Provider token leaked to browser storage');
  await page.screenshot({path:'output/playwright/provider-saved.png',fullPage:true});
  console.log('PASS model filtering, changed connection resets selection, save/dimension detection, reload/runtime probe and no browser storage token');
}
