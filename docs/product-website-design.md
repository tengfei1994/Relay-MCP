# Relay product website and console

This design describes the public product site, access requests and the existing console. All interface copy is in English. The current Relay visual system supplies the typefaces, colours and components.

## Visual revision — 2026-11-05

The primary reference is [Linear on Refero Styles](https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1), selected for its restrained product presentation and readable operational hierarchy. Relay uses neutral charcoal surfaces, white and gray typography, fine borders and a lime primary action. The existing locally bundled IBM Plex Sans and Mono fonts are retained; the Relay mark and product content remain original.

The homepage leads with an interactive, explicitly illustrative tour of Projects, Knowledge and Memory. Tabs support arrow keys, Home and End; example document search includes an empty state. Product access and Memory review rules are explained in the page content. Entrance, tab and hover motion uses short opacity and transform transitions; reduced-motion preferences expose the final state immediately. Login, console navigation, fields, overlays and review surfaces share the same neutral palette. Public contact information remains unconfigured until a channel is provided.

## Information architecture

- **Public:** product introduction, capabilities, getting started, contact status, sign in and request access. The public home page does not require a session.
- **Applicant:** submit a username and password. Except for the initial administrator bootstrap, a request remains pending until an administrator reviews it. No invitation code or invitation link is required.
- **Signed-in user:** projects and their files, servers, instances, tools, Knowledge, MCP Access Tokens, Relay Agent Tokens and account settings. Project and Knowledge permissions are separate.
- **Administrator:** the same console plus user administration, request decisions and Knowledge review. Administrator status does not imply product Knowledge access or access to another user's projects.

## Key flows

1. A visitor selects **Request access**, submits the form and sees a pending message. The applicant cannot sign in before approval. A rejected or disabled account receives an explanatory sign-in response after providing valid credentials.
2. An administrator reviews the request in **Users**, optionally records a reason, and approves or rejects it. Approval does not grant Product Knowledge and General Memory. An administrator may later disable or enable an account.
3. A user changes their password in **Account** by supplying the current password. Usernames remain administrator-managed. Password recovery and notifications are not configured.
4. A user creates an MCP Access Token for an MCP client, with selected projects or no project. A Relay Agent Token authorizes a particular configured agent server. Token secrets are shown once on creation. **Delete** invalidates later requests.
5. A user opens **Projects** to browse authorized files. The server checks project ownership and paths for each operation. No project is needed for an authorized user's public product Knowledge or General Memory.

## Layout and states

Desktop navigation separates the public site from the authenticated console. The authenticated console keeps primary destinations in the top bar and exposes only contextual Knowledge, token and administrator sections in one desktop side rail; mobile collapses primary navigation into a menu and exposes contextual sections as horizontal tabs. Mobile layouts stack content and keep sign in, access request and console navigation reachable. Forms have persistent labels, keyboard focus, loading feedback and visible error or empty states. Motion respects reduced-motion settings. The public contact section explicitly says when no public channel is configured.

## Decisions still needed before publication

- Confirm brand assets, public product claims and the contact channel. The current site uses the existing Relay name and does not invent a contact address.
- Decide whether account recovery, registration notifications and additional self-service profile fields are needed. None are implied by approval.
- Confirm privacy and terms content before publishing links to them; no policy text or URLs have been invented.
- Review the interface and copy with the product owner, then complete desktop, mobile, keyboard and screen-reader acceptance in a non-production environment.

Bootstrap the first administrator in a trusted environment before exposing registration publicly. Back up the application and Knowledge databases, Evidence, engine data and configuration before deployment; rehearse migration and rollback using matching backups.
