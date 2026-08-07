# Relay Agent Client WPF Design QA

final result: passed

## Reference

- Selected direction: adaptive WPF operations workspace.
- Visual language: light neutral workspace, compact left navigation, blue
  primary actions, restrained status colors, and dense administrative tables.
- Additional requirement: Command Audit is a separate page.
- Current priority: avoid DPI text clipping, hidden section titles, and fixed
  terminal/log panes.

## Verified Screens

- Default viewport: 1240 x 820.
- Compact viewport: 980 x 760.
- High-DPI work-area viewport: 1060 x 680.
- Minimum viewport: 900 x 700.
- Overview, Secure Connection, Windows Service, Database Access, Request
  Audit, Diagnostics, and all five Playwright tabs.

## Checks

- Main navigation, header metrics, content panels, and footer use WPF Grid,
  WrapPanel, Auto, MinHeight, and Padding instead of tightly fixed rows.
- Overview, Service, Database, Playwright Runtime, and Playwright Suite editor
  switch from side-by-side panels to stacked panels when available content
  width crosses the compact breakpoint.
- The sidebar collapses to an icon rail at compact window widths.
- Initial window bounds are calculated from the current WPF work area, so a
  high-DPI display does not turn the nominal 1240 x 820 size into an almost
  full-screen window. Users can still maximize the window explicitly.
- On short, sufficiently wide work areas, the global status metrics move next
  to the Agent operations heading to release vertical space for page content.
- Sidebar navigation scrolls independently on short work areas instead of
  clipping its final items or the service-owned execution notice.
- Outer page horizontal scrolling is disabled. Data tables retain their own
  bounded horizontal scrolling when their columns require it.
- Connection fields and page action toolbars move to additional rows at their
  compact breakpoints.
- Database stacking preserves the operational order: Target, Access actions,
  then Permission evidence.
- Runtime, suite, and audit content use vertical scrolling at short viewport
  heights instead of clipping lower panels.
- Diagnostics uses page-level vertical scrolling at short heights. Its Agent
  log terminal keeps a usable minimum height and the log toolbar remains on a
  single row whenever the available width permits it.
- Section titles are outside fill controls, reducing the title-overlap issue
  seen in earlier screenshots.
- Status text uses badge-like padding and minimum height to reduce descender
  clipping at higher DPI.
- Relay URL host and port are fully masked after save.
- Agent token is masked and can only be replaced, not revealed.
- Database actions are separated from the Command Audit workflow.
- Command Audit filters, actions, table, and selected-command detail are on
  separate resizable regions.
- Command Audit QA uses 105 isolated local job fixtures, verifies that only the
  latest 100 rows load, waits for the background refresh, and selects a command
  with command/output details. It never reads the host's real Agent data.
- Playwright runtime log, selected run details, request details, and Agent log
  use terminal-style output panes with search, copy, wrapping, and zoom.
- Destructive actions use a distinct danger treatment and confirmation.
- Controls use consistent spacing, typography, borders, and interaction color.
- Minimizing hides the WPF window and taskbar entry while exposing the Windows
  notification-area icon. Restoring from the tray reverses all three states;
  the lifecycle is exercised by the repeatable offscreen QA script.
- Playwright Test runs QA includes a selected run fixture so the detail
  terminal is verified with realistic output, not only an empty-state label.
- Playwright Test runs switch from proportional rows to bounded content rows
  plus page scrolling on short work areas, keeping Selected run output usable.

## Remaining Polish

- `MainWindow.xaml` is still the primary composition surface. Future work
  should split feature pages into WPF UserControls and move behavior toward
  view models.
- A final smoke check on the actual Windows Server 2019 host remains useful
  before a release tag because installed fonts and system DPI policies can
  differ from the development machine.
