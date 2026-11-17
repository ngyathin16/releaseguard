# Walkthrough

[Play the captioned recording](walkthrough.webm). [WebVTT captions](walkthrough.vtt) and [capture metadata](walkthrough-capture.json) accompany it. Captions are also visible in the recording itself.

This records the real local application: a healthy first-stage canary, explicit stop and observed baseline routing, then missing telemetry producing an inconclusive result and withdrawal. It is a saved recording, not a currently running experiment. Only the caption overlay is added to the page. Actual requests and judgments are never replaced with fixture responses.

Start the built application, then run `npm run walkthrough`. The script records a 72-second workflow and validates the decoded recording's 60–90-second duration and 1440×1000 dimensions before publication. A slower host can lengthen it while waiting for real results. Microsoft Edge is used on Windows; other platforms use Playwright Chromium or `BROWSER_EXECUTABLE`. Capture it independently of other timing-sensitive checks when comparing durations.
