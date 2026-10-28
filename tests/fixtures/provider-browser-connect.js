async (page) => {
  await page.goto('http://127.0.0.1:19742/knowledge/integrated?tab=providers');
  await page.getByRole('textbox', {name:'Provider ID', exact:true}).fill('browser-embedding');
  await page.getByRole('textbox', {name:'Base URL', exact:true}).fill('http://127.0.0.1:19743');
  await page.getByRole('textbox', {name:'API token', exact:true}).fill('bad-token');
  await page.getByRole('button', {name:'Fetch models', exact:true}).click();
  await page.getByRole('alert').filter({hasText:'authorization failed'}).waitFor();
  if (await page.getByRole('button', {name:'Test and save', exact:true}).count()) throw new Error('Failed discovery allowed saving');
  await page.getByRole('textbox', {name:'API token', exact:true}).fill('e2e-provider-token');
  await page.getByRole('button', {name:'Fetch models', exact:true}).click();
  await page.getByRole('combobox', {name:'Model', exact:true}).waitFor();
  return { passed: true, checks: ['bad token blocks saving', 'authenticated discovery'] };
}
