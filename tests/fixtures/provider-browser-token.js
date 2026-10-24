async (page) => {
  if (!await page.getByRole('textbox', {name:'Replacement token', exact:true}).count()) await page.getByRole('button', {name:'Replace token', exact:true}).click();
  await page.getByRole('textbox', {name:'Replacement token', exact:true}).fill('bad-token');
  await page.getByRole('button', {name:'Test and replace', exact:true}).click();
  await page.getByText('Managed provider authorization failed; check the token', {exact:true}).waitFor();
  await page.getByRole('textbox', {name:'Replacement token', exact:true}).fill('e2e-replacement-token');
  await page.getByRole('button', {name:'Test and replace', exact:true}).click();
  await page.getByText('Token tested and replaced.', {exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button', {name:'Test', exact:true}).click();
  await page.getByText(/Probe ok/).waitFor();
  return { passed: true, checks: ['replacement validation', 'replacement persisted after reload', 'runtime probe'] };
}
