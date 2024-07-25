import { ConfigurationFile } from "./ConfigurationBuilder";

interface DefiniteConfig {
  [key: string]: string | number | boolean;
}
export class Configuration {
  readonly storedConfigTemplate: ConfigurationFile;
  definiteConfig: DefiniteConfig = {};
  constructor(configTemplate: ConfigurationFile) {
    this.storedConfigTemplate = configTemplate;
  }

  updateConfig(config: DefiniteConfig, validate: boolean = true): [ boolean, { [key: string]: string } ] {
    this.definiteConfig = config;
    if (validate) {
      const result = this.validateConfig();
      return result;
    }
    return [ true, {} ];
  }
  // provides falsey or truthy value, and an error message if falsey
  private validateConfig(): [ boolean, { [key: string]: string } ] {
    const erroredKeys = new Map<string, string>();
    for (const key in this.storedConfigTemplate) {
      if (this.definiteConfig[key] === null || this.definiteConfig[key] === undefined) {
        console.warn('Option ' + key + ' is not defined. Using default value Value: ' + this.definiteConfig[key]);
        this.definiteConfig[key] = this.storedConfigTemplate[key].defaultValue as string | number | boolean;
      }
      if (this.storedConfigTemplate[key].type !== typeof this.definiteConfig[key]) {
        throw new Error('Option ' + key + ' is not of the correct type');
      }

      const result = this.storedConfigTemplate[key].validate(this.definiteConfig[key]);
      if (!result[0]) {
        erroredKeys.set(key, result[1]);
      }
    }

    for (const key in this.definiteConfig) {
      if (!this.storedConfigTemplate[key]) {
        throw new Error('Option ' + key + ' is not defined in the configuration template');
      }
    }

    if (erroredKeys.size > 0) {
      return [ false, Object.fromEntries(erroredKeys) ];
    }

    return [ true, Object.fromEntries(erroredKeys) ];
  }

  getStringValue(optionName: string): string {
    if (!this.definiteConfig[optionName] === null) {
      throw new Error('Option ' + optionName + ' is not defined');
    }
    if (typeof this.definiteConfig[optionName] !== 'string') {
      throw new Error('Option ' + optionName + ' is not a string');
    }
    return this.definiteConfig[optionName];
  }

  getNumberValue(optionName: string): number {
    if (!this.definiteConfig[optionName] === null) {
      throw new Error('Option ' + optionName + ' is not defined');
    }
    if (typeof this.definiteConfig[optionName] !== 'number') {
      throw new Error('Option ' + optionName + ' is not a number');
    }
    return this.definiteConfig[optionName];
  }

  getBooleanValue(optionName: string): boolean {
    if (this.definiteConfig[optionName] === null) {
      throw new Error('Option ' + optionName + ' is not defined');
    }
    if (typeof this.definiteConfig[optionName] !== 'boolean') {
      throw new Error('Option ' + optionName + ' is not a boolean');
    }
    return this.definiteConfig[optionName];
  }
}