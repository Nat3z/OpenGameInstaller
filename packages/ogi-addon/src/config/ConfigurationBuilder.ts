import z, { ZodError } from 'zod';

export interface ConfigurationFile {
  [key: string]: ConfigurationOption;
}

const configValidation = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
});

export function isStringOption(
  option: ConfigurationOption
): option is StringOption {
  return option.type === 'string';
}

export function isNumberOption(
  option: ConfigurationOption
): option is NumberOption {
  return option.type === 'number';
}

export function isBooleanOption(
  option: ConfigurationOption
): option is BooleanOption {
  return option.type === 'boolean';
}

export function isActionOption(
  option: ConfigurationOption
): option is ActionOption {
  return option.type === 'action';
}

export class ConfigurationBuilder {
  private options: ConfigurationOption[] = [];

  /**
   * Add a number option to the configuration builder and return the builder for chaining. You must provide a name, display name, and description for the option.
   * @param option { (option: NumberOption) => NumberOption }
   * @returns
   */
  public addNumberOption(
    option: (option: NumberOption) => NumberOption
  ): ConfigurationBuilder {
    let newOption = new NumberOption();
    newOption = option(newOption);
    this.options.push(newOption);
    return this;
  }

  /**
   * Add a string option to the configuration builder and return the builder for chaining. You must provide a name, display name, and description for the option.
   * @param option { (option: StringOption) => StringOption }
   */
  public addStringOption(option: (option: StringOption) => StringOption) {
    let newOption = new StringOption();
    newOption = option(newOption);
    this.options.push(newOption);
    return this;
  }

  /**
   * Add a boolean option to the configuration builder and return the builder for chaining. You must provide a name, display name, and description for the option.
   * @param option { (option: BooleanOption) => BooleanOption }
   */
  public addBooleanOption(option: (option: BooleanOption) => BooleanOption) {
    let newOption = new BooleanOption();
    newOption = option(newOption);
    this.options.push(newOption);
    return this;
  }

  /**
   * Add an action option to the configuration builder and return the builder for chaining. You must provide a name, display name, and description for the option.
   * @param option { (option: ActionOption) => ActionOption }
   */
  public addActionOption(option: (option: ActionOption) => ActionOption) {
    let newOption = new ActionOption();
    newOption = option(newOption);
    this.options.push(newOption);
    return this;
  }

  public build(includeFunctions: boolean): ConfigurationFile {
    let config: ConfigurationFile = {};
    this.options.forEach((option) => {
      // remove all functions from the option object
      if (!includeFunctions) {
        option = JSON.parse(JSON.stringify(option));
        const optionData = configValidation.safeParse(option);
        if (!optionData.success) {
          throw new ZodError(optionData.error.errors);
        }

        config[option.name] = option;
      } else {
        config[option.name] = option;
      }
    });
    return config;
  }
}

export type ConfigurationOptionType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'action'
  | 'unset';
export class ConfigurationOption {
  public name: string = '';
  public defaultValue: unknown = '';
  public displayName: string = '';
  public description: string = '';
  public type: ConfigurationOptionType = 'unset';

  /**
   * Set the name of the option. **REQUIRED**
   * @param name {string} The name of the option. This is used to reference the option in the configuration file.
   */
  setName(name: string) {
    this.name = name;
    return this;
  }

  /**
   * Set the display name of the option. This is used to show the user a human readable version of what the option is. **REQUIRED**
   * @param displayName {string} The display name of the option.
   * @returns
   */
  setDisplayName(displayName: string) {
    this.displayName = displayName;
    return this;
  }

  /**
   * Set the description of the option. This is to show the user a brief description of what this option does. **REQUIRED**
   * @param description {string} The description of the option.
   * @returns
   */
  setDescription(description: string) {
    this.description = description;
    return this;
  }

  /**
   * Validation code for the option. This is called when the user provides input to the option. If the validation fails, the user will be prompted to provide input again.
   * @param input {unknown} The input to validate
   */
  validate(input: unknown): [boolean, string] {
    throw new Error('Validation code not implemented. Value: ' + input);
  }
}

export class StringOption extends ConfigurationOption {
  public allowedValues: string[] = [];
  public minTextLength: number = 0;
  public maxTextLength: number = Number.MAX_SAFE_INTEGER;
  public defaultValue: string = '';
  public inputType: 'text' | 'file' | 'password' | 'folder' = 'text';
  public type: ConfigurationOptionType = 'string';

  /**
   * Set the allowed values for the string. If the array is empty, any value is allowed. When provided, the client will act like this option is a dropdown.
   * @param allowedValues {string[]} An array of allowed values for the string. If the array is empty, any value is allowed.
   */
  setAllowedValues(allowedValues: string[]): this {
    this.allowedValues = allowedValues;
    return this;
  }

  /**
   * Set the default value for the string. This value will be used if the user does not provide a value. **HIGHLY RECOMMENDED**
   * @param defaultValue {string} The default value for the string.
   */
  setDefaultValue(defaultValue: string): this {
    this.defaultValue = defaultValue;
    return this;
  }

  /**
   * Set the minimum text length for the string. If the user provides a string that is less than this value, the validation will fail.
   * @param minTextLength {number} The minimum text length for the string.
   */
  setMinTextLength(minTextLength: number): this {
    this.minTextLength = minTextLength;
    return this;
  }

  /**
   * Set the maximum text length for the string. If the user provides a string that is greater than this value, the validation will fail.
   * @param maxTextLength {number} The maximum text length for the string.
   */
  setMaxTextLength(maxTextLength: number): this {
    this.maxTextLength = maxTextLength;
    return this;
  }

  /**
   * Set the input type for the string. This will change how the client renders the input.
   * @param inputType {'text' | 'file' | 'password' | 'folder'} The input type for the string.
   */
  setInputType(inputType: 'text' | 'file' | 'password' | 'folder'): this {
    this.inputType = inputType;
    return this;
  }

  override validate(input: unknown): [boolean, string] {
    if (typeof input !== 'string') {
      return [false, 'Input is not a string'];
    }
    if (this.allowedValues.length === 0 && input.length !== 0)
      return [true, ''];
    if (
      input.length < this.minTextLength ||
      input.length > this.maxTextLength
    ) {
      return [
        false,
        'Input is not within the text length ' +
          this.minTextLength +
          ' and ' +
          this.maxTextLength +
          ' characters (currently ' +
          input.length +
          ' characters)',
      ];
    }

    return [
      this.allowedValues.includes(input),
      'Input is not an allowed value',
    ];
  }
}

export class NumberOption extends ConfigurationOption {
  public min: number = 0;
  public max: number = Number.MAX_SAFE_INTEGER;
  public defaultValue: number = 0;
  public type: ConfigurationOptionType = 'number';
  public inputType: 'range' | 'number' = 'number';

  /**
   * Set the minimum value for the number. If the user provides a number that is less than this value, the validation will fail.
   * @param min {number} The minimum value for the number.
   */
  setMin(min: number): this {
    this.min = min;
    return this;
  }

  /**
   * Set the input type for the number. This will change how the client renders the input.
   * @param type {'range' | 'number'} The input type for the number.
   */
  setInputType(type: 'range' | 'number'): this {
    this.inputType = type;
    return this;
  }

  /**
   * Set the maximum value for the number. If the user provides a number that is greater than this value, the validation will fail.
   * @param max {number} The maximum value for the number.
   */
  setMax(max: number): this {
    this.max = max;
    return this;
  }

  /**
   * Set the default value for the number. This value will be used if the user does not provide a value. **HIGHLY RECOMMENDED**
   * @param defaultValue {number} The default value for the number.
   */
  setDefaultValue(defaultValue: number): this {
    this.defaultValue = defaultValue;
    return this;
  }

  override validate(input: unknown): [boolean, string] {
    if (isNaN(Number(input))) {
      return [false, 'Input is not a number'];
    }
    if (Number(input) < this.min || Number(input) > this.max) {
      return [
        false,
        'Input is not within the range of ' + this.min + ' and ' + this.max,
      ];
    }
    return [true, ''];
  }
}

export class BooleanOption extends ConfigurationOption {
  public type: ConfigurationOptionType = 'boolean';
  public defaultValue: boolean = false;

  /**
   * Set the default value for the boolean. This value will be used if the user does not provide a value. **HIGHLY RECOMMENDED**
   * @param defaultValue {boolean} The default value for the boolean.
   */
  setDefaultValue(defaultValue: boolean): this {
    this.defaultValue = defaultValue;
    return this;
  }

  override validate(input: unknown): [boolean, string] {
    if (typeof input !== 'boolean') {
      return [false, 'Input is not a boolean'];
    }
    return [true, ''];
  }
}

export class ActionOption extends ConfigurationOption {
  public type: ConfigurationOptionType = 'action';
  public manifest: Record<string, unknown> = {};
  public buttonText: string = 'Run';
  public taskName: string = '';

  /**
   * Set the task name that will be used to identify which task handler to run. This should match the name used in `addon.onTask()`.
   * @param taskName {string} The task name to identify the handler.
   */
  setTaskName(taskName: string): this {
    this.taskName = taskName;
    return this;
  }

  /**
   * Set the manifest object that will be passed to the task-run handler. The task name should be set via setTaskName() rather than in the manifest.
   * @param manifest {Record<string, unknown>} The manifest object to pass to the task handler.
   */
  setManifest(manifest: Record<string, unknown>): this {
    this.manifest = manifest;
    return this;
  }

  /**
   * Set the text displayed on the action button.
   * @param text {string} The button text.
   */
  setButtonText(text: string): this {
    this.buttonText = text;
    return this;
  }

  override validate(_input: unknown): [boolean, string] {
    return [true, ''];
  }
}
