# Use WebdriverIO for Electron end-to-end automation

The end-to-end harness will use WebdriverIO with its Electron service for Windows and Linux automation. We chose it over Playwright's experimental Electron API because the suite must exercise Electron Builder packaged and unpackaged applications, follow splash-to-main window transitions, capture Electron process logs, and run under Xvfb on Linux; the harness will wrap WebdriverIO and translate its lifecycle into project-owned run events rather than coupling the Observer Window to WebdriverIO's presentation.
