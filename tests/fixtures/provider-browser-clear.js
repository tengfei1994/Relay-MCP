async (page) => {
  await page.getByText('Token cleared; provider disabled.', {exact:true}).waitFor();
  if (!await page.getByRole('button', {name:'Clear token', exact:true}).isDisabled()) throw new Error('Clear did not clear token metadata');
  if (!await page.getByRole('button', {name:'Disable', exact:true}).isDisabled()) throw new Error('Clear did not disable provider');
  if (await page.getByText(/Probe ok/).count()) throw new Error('Cleared provider shows stale successful probe');
  await page.screenshot({path:'output/playwright/provider-cleared.png',fullPage:true});
  return { passed: true, checks: ['clear disables provider', 'no stale successful probe'] };
}
