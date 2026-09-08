# Initial iOS release — App Store Connect copy and review checklist

These are proposed fields for final review. They have not been entered in App
Store Connect. The initial iOS release supports ESPN and Sleeper; Yahoo is
available separately on the website and must not appear in iOS screenshots,
keywords, promotional text or provider claims.

| Field | Proposed value |
| --- | --- |
| Name | Fantasy Sports Network |
| Subtitle | League Analytics & Records |
| Keywords | fantasy,football,league,analytics,matchups,records,history,standings,ESPN,Sleeper |
| Promotional text | Explore your fantasy football league with advanced analytics, matchup previews and a record book built from your league's available scores and history. |
| Support URL | https://fantasysportsnetwork.app/support |
| Privacy Policy URL | https://fantasysportsnetwork.app/privacy |
| Marketing URL | https://fantasysportsnetwork.app |
| Terms link in app | https://fantasysportsnetwork.app/terms |

## Description

Give your fantasy football league a home beyond the scoreboard.

Fantasy Sports Network connects your ESPN or Sleeper league to a league desk
with advanced analytics, matchup previews and a record book. Explore standings,
compare teams, follow weekly stories and revisit the performances that shape
your league's history.

- Advanced analytics and team comparisons based on your league data.
- Matchup previews and weekly league coverage.
- League records and historical season views using available or imported data.
- Saved leagues for returning to your league desk.

Enter your league ID to connect. Access to private leagues and historical
seasons depends on your provider and may require credentials or an import.
FSN does not ask for your ESPN or Sleeper account password. This iOS release
supports ESPN and Sleeper fantasy football leagues.

## Reviewer access — complete before Add for Review

Provide a working, authorized review league ID and provider in App Review Notes.
Test that exact ID in a fresh installation of the new build, including every
screen. A random or sample ID cannot guarantee that a provider returns data.
If review access needs private credentials or a history import, provide those
instructions and approved test data through App Store Connect's review fields.
No verified review league or bundled demo has been added by this change.

Explain Setup → Privacy & Data for Support, policies and local erasure. Alerts
are optional and unavailable when the production APNs service is not configured;
do not advertise delivery until configuration and device testing pass.

## Privacy and release sign-off

- Publish and recheck the updated privacy policy and both association files
  after merge. The source changes alone do not update the live pages.
- Reconcile App Privacy answers with provider credentials sent through relays,
  optional notification addresses/preferences, and optional cloud records.
  Review website-only Yahoo storage separately: disconnecting the current web
  session does not delete retained encrypted provider tokens or other sessions.
- Local erasure removes FSN-owned local/session storage and resets onboarding
  after successful device disconnect. Shared cloud records, other devices and
  website signup records require the policy's separate deletion process.
- Use screenshots from the rebuilt iOS app, with no Yahoo control or stale
  launch copy. Confirm age rating, content rights and contact information in
  Connect; these account fields were not accessible during the code review.
- Finish the IPA gate and real-device checks in HANDOFF.md. App Review approval
  remains Apple's decision; this checklist does not guarantee acceptance.
