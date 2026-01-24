import {
  ConfigurationBuilder,
  BooleanOption,
  ConfigurationOption,
  NumberOption,
  StringOption,
  ActionOption,
  isBooleanOption,
  isNumberOption,
  isStringOption,
  isActionOption,
} from './ConfigurationBuilder';
import type {
  ConfigurationFile,
  ConfigurationOptionType,
} from './ConfigurationBuilder';

interface DefiniteConfig {
  [key: string]: string | number | boolean;
}
export class Configuration {
  readonly storedConfigTemplate: ConfigurationFile;
  definiteConfig: DefiniteConfig = {};
  constructor(configTemplate: ConfigurationFile) {
    this.storedConfigTemplate = configTemplate;
  }

  updateConfig(
    config: DefiniteConfig,
    validate: boolean = true
  ): [boolean, { [key: string]: string }] {
    this.definiteConfig = config;
    if (validate) {
      const result = this.validateConfig();
      return result;
    }
    return [true, {}];
  }
  // provides falsey or truthy value, and an error message if falsey
  private validateConfig(): [boolean, { [key: string]: string }] {
    const erroredKeys = new Map<string, string>();
    for (const key in this.storedConfigTemplate) {
      if (
        this.storedConfigTemplate[key].type !== 'action' &&
        (this.definiteConfig[key] === null ||
          this.definiteConfig[key] === undefined)
      ) {
        console.warn(
          'Option ' +
            key +
            ' is not defined. Using default value Value: ' +
            this.storedConfigTemplate[key].defaultValue
        );
        this.definiteConfig[key] = this.storedConfigTemplate[key]
          .defaultValue as string | number | boolean;
      }
      if (
        this.storedConfigTemplate[key].type !== 'action' &&
        this.storedConfigTemplate[key].type !== typeof this.definiteConfig[key]
      ) {
        throw new Error('Option ' + key + ' is not of the correct type.');
      }

      if (this.storedConfigTemplate[key].type === 'action') {
        continue;
      }

      const result = this.storedConfigTemplate[key].validate(
        this.definiteConfig[key]
      );
      if (!result[0]) {
        erroredKeys.set(key, result[1]);
      }
    }

    for (const key in this.definiteConfig) {
      if (this.storedConfigTemplate[key] === undefined) {
        // remove the key from the definite config
        delete this.definiteConfig[key];
        console.warn(
          'Option ' +
            key +
            ' is not defined in the configuration template. Removing from config.'
        );
      }
    }

    if (erroredKeys.size > 0) {
      return [false, Object.fromEntries(erroredKeys)];
    }

    return [true, Object.fromEntries(erroredKeys)];
  }

  getStringValue(optionName: string): string {
    if (
      this.definiteConfig[optionName] === null ||
      this.definiteConfig[optionName] === undefined
    ) {
      throw new Error('Option ' + optionName + ' is not defined');
    }
    if (typeof this.definiteConfig[optionName] !== 'string') {
      throw new Error('Option ' + optionName + ' is not a string');
    }
    return this.definiteConfig[optionName];
  }

  getNumberValue(optionName: string): number {
    if (
      this.definiteConfig[optionName] === null ||
      this.definiteConfig[optionName] === undefined
    ) {
      throw new Error('Option ' + optionName + ' is not defined');
    }
    if (typeof this.definiteConfig[optionName] !== 'number') {
      throw new Error('Option ' + optionName + ' is not a number');
    }
    return this.definiteConfig[optionName];
  }

  getBooleanValue(optionName: string): boolean {
    if (
      this.definiteConfig[optionName] === null ||
      this.definiteConfig[optionName] === undefined
    ) {
      throw new Error('Option ' + optionName + ' is not defined');
    }
    if (typeof this.definiteConfig[optionName] !== 'boolean') {
      throw new Error('Option ' + optionName + ' is not a boolean');
    }
    return this.definiteConfig[optionName];
  }
}

export {
  ConfigurationBuilder,
  BooleanOption,
  ConfigurationOption,
  NumberOption,
  StringOption,
  ActionOption,
  isBooleanOption,
  isNumberOption,
  isStringOption,
  isActionOption,
};

export type { ConfigurationFile, ConfigurationOptionType };
