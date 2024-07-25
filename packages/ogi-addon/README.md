# OGI-Addon
A library to interface with OpenGameInstaller's addon system.

# Installation
```bash
$ npm install ogi-addon
```

# Examples
Check out the [test-addon](https://github.com/Nat3z/OpenGameInstaller/tree/main/test-addon) folder to see how to use the addon library.

# Boilerplate
Your addon should include an `addon.json` file which describes how to setup your addon. It should always include a `run` script so OpenGameInstaller will know how to start your addon.
```typescript
interface AddonFileConfigurationSchema {
  author: string,
  scripts: {
    setup?: string,
    run: string,
    preSetup?: string,
    postSetup?: string 
  }
}
```

## How to Develop
In OpenGameInstaller, go to `Settings > General` and use the **local:** prefix to define that your addon is hosted locally instead of through a remote git repository.

For Example:
```
local:C:\Users\[you]\Documents\Addon\
```

This will allow OpenGameInstaller to launch your addon securely instead of opening up the addon server for unsigned connections.

### Disable Signature Requirement for Addons
If you want to debug your addon without relying on OpenGameInstaller to launch it, you can disable the signature requirement.

⚠️ **WARNING** This is VERY unsafe to do, as it allows for any malicious program to connect to the addon server without needing to provide the addon secret. We recommend enabling this temporarily for debugging purposes and disabling it once you can.

To disable the signature requirement, go to `Settings > Developer` and select **Disable Server Secret Check**. Restart OpenGameInstaller.