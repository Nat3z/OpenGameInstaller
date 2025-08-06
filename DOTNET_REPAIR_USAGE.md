# .NET Framework Repair Tool Usage

The .NET Framework Repair Tool has been integrated into the OpenGameInstaller redistributables system.

## How to Use

To use the .NET Framework Repair Tool in your addon, add it to your redistributables array like this:

```typescript
// In your addon's setup event handler
addon.on('setup', (steamAppID, event) => {
  event.defer();

  // Your game setup logic here...

  event.resolve({
    name: 'Your Game Name',
    path: '/path/to/game',
    executable: 'game.exe',
    // ... other LibraryInfo properties

    // Add the .NET repair tool as a redistributable
    redistributables: [
      {
        name: 'dotnet-repair',
        path: 'microsoft',
      },
      // ... other redistributables
    ],
  });
});
```

## What it does

When a game with this redistributable is set up:

1. **Downloads**: The tool automatically downloads the Microsoft .NET Framework Repair Tool from the official Microsoft URL
2. **Caches**: The downloaded tool is cached in the application directory for future use
3. **Executes**: Runs the repair tool through Wine with the `/p` flag as requested
4. **Wine Integration**: Uses the game's Wine prefix and proper environment variables
5. **Logging**: Provides detailed logging with `[dotnet-repair]` prefix for debugging

## Technical Details

- **Tool Path**: `microsoft` (similar to `winetricks`)
- **Tool Name**: `dotnet-repair`
- **Download URL**: `https://download.microsoft.com/download/2/b/d/2bde5459-2225-48b8-830c-ae19caf038f1/NetFxRepairTool.exe`
- **Execution**: `wine NetFxRepairTool.exe /p`
- **Environment**: Uses the game's Wine prefix with proper display and debug settings

## Example with Multiple Redistributables

```typescript
redistributables: [
  {
    name: 'dotnet-repair',
    path: 'microsoft',
  },
  {
    name: 'vcredist2019',
    path: 'winetricks',
  },
  {
    name: 'My Custom Redistributable',
    path: '/path/to/custom/redistributable.exe',
  },
];
```

The .NET repair tool will be processed alongside other redistributables during game setup.
