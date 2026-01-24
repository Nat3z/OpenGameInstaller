import z, { ZodError } from 'zod';

export interface ConfigurationFile {
  [key: string]: ConfigurationOption<string>;
}

const configValidation = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
});

export function isStringOption<N extends string = string>(
  option: ConfigurationOption<N>
): option is StringOption<N> {
  return option.type === 'string';
}

export function isNumberOption<N extends string = string>(
  option: ConfigurationOption<N>
): option is NumberOption<N> {
  return option.type === 'number';
}

export function isBooleanOption<N extends string = string>(
  option: ConfigurationOption<N>
): option is BooleanOption<N> {
  return option.type === 'boolean';
}

export function isActionOption<N extends string = string>(
  option: ConfigurationOption<N>
): option is ActionOption<N> {
  return option.type === 'action';
}

/**
 * A builder for creating configuration screens. The generic type T accumulates
 * the types of all options added to the builder, enabling type-safe access to
 * the configuration values.
 * 
 * @template T - The accumulated type of all configuration options
 */
export class ConfigurationBuilder<
  T extends Record<string, string | number | boolean> = {}
> {
  private options: ConfigurationOption<string>[] = [];

  /**
   * Add a number option to the configuration builder and return the builder for chaining. You must provide a name, display name, and description for the option.
   * @param option { (option: NumberOption) => NumberOption<K> }
   * @returns A new ConfigurationBuilder with the number option's type added
   */
  public addNumberOption<K extends string>(
    option: (option: NumberOption) => NumberOption<K>
  ): ConfigurationBuilder<T & { [P in K]: number }> {
    let newOption = new NumberOption();
    const configuredOption = option(newOption);
    this.options.push(configuredOption);
    return this as unknown as ConfigurationBuilder<T & { [P in K]: number }>;
  }

  /**
   * Add a string option to the configuration builder and return the builder for chaining. You must provide a name, display name, and description for the option.
   * @param option { (option: StringOption) => StringOption<K> }
   * @returns A new ConfigurationBuilder with the string option's type added
   */
  public addStringOption<K extends string>(
    option: (option: StringOption) => StringOption<K>
  ): ConfigurationBuilder<T & { [P in K]: string }> {
    let newOption = new StringOption();
    const configuredOption = option(newOption);
    this.options.push(configuredOption);
    return this as unknown as ConfigurationBuilder<T & { [P in K]: string }>;
  }

  /**
   * Add a boolean option to the configuration builder and return the builder for chaining. You must provide a name, display name, and description for the option.
   * @param option { (option: BooleanOption) => BooleanOption<K> }
   * @returns A new ConfigurationBuilder with the boolean option's type added
   */
  public addBooleanOption<K extends string>(
    option: (option: BooleanOption) => BooleanOption<K>
  ): ConfigurationBuilder<T & { [P in K]: boolean }> {
    let newOption = new BooleanOption();
    const configuredOption = option(newOption);
    this.options.push(configuredOption);
    return this as unknown as ConfigurationBuilder<T & { [P in K]: boolean }>;
  }

  /**
   * Add an action option to the configuration builder and return the builder for chaining. 
   * Action options contribute a boolean to the return type (true if clicked, false if not).
   * You must provide a name, display name, and description for the option.
   * @param option { (option: ActionOption) => ActionOption<K> }
   * @returns A new ConfigurationBuilder with the action option's type added as boolean
   */
  public addActionOption<K extends string>(
    option: (option: ActionOption) => ActionOption<K>
  ): ConfigurationBuilder<T & { [P in K]: boolean }> {
    let newOption = new ActionOption();
    const configuredOption = option(newOption);
    this.options.push(configuredOption);
    return this as unknown as ConfigurationBuilder<T & { [P in K]: boolean }>;
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
export class ConfigurationOption<N extends string = string> {
  public name: N = '' as N;
  public defaultValue: unknown = '';
  public displayName: string = '';
  public description: string = '';
  public type: ConfigurationOptionType = 'unset';

  /**
   * Set the name of the option. **REQUIRED**
   * @param name {string} The name of the option. This is used to reference the option in the configuration file.
   */
  setName<K extends string>(name: K): ConfigurationOption<K> {
    this.name = name as unknown as N;
    return this as unknown as ConfigurationOption<K>;
  }

  /**
   * Set the display name of the option. This is used to show the user a human readable version of what the option is. **REQUIRED**
   * @param displayName {string} The display name of the option.
   * @returns
   */
  setDisplayName(displayName: string): this {
    this.displayName = displayName;
    return this;
  }

  /**
   * Set the description of the option. This is to show the user a brief description of what this option does. **REQUIRED**
   * @param description {string} The description of the option.
   * @returns
   */
  setDescription(description: string): this {
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

export class StringOption<N extends string = string> extends ConfigurationOption<N> {
  public allowedValues: string[] = [];
  public minTextLength: number = 0;
  public maxTextLength: number = Number.MAX_SAFE_INTEGER;
  public defaultValue: string = '';
  public inputType: 'text' | 'file' | 'password' | 'folder' = 'text';
  public type: ConfigurationOptionType = 'string';

  /**
   * Set the name of the option. **REQUIRED**
   * @param name {string} The name of the option. This is used to reference the option in the configuration file.
   */
  override setName<K extends string>(name: K): StringOption<K> {
    this.name = name as unknown as N;
    return this as unknown as StringOption<K>;
  }

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

export class NumberOption<N extends string = string> extends ConfigurationOption<N> {
  public min: number = 0;
  public max: number = Number.MAX_SAFE_INTEGER;
  public defaultValue: number = 0;
  public type: ConfigurationOptionType = 'number';
  public inputType: 'range' | 'number' = 'number';

  /**
   * Set the name of the option. **REQUIRED**
   * @param name {string} The name of the option. This is used to reference the option in the configuration file.
   */
  override setName<K extends string>(name: K): NumberOption<K> {
    this.name = name as unknown as N;
    return this as unknown as NumberOption<K>;
  }

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

export class BooleanOption<N extends string = string> extends ConfigurationOption<N> {
  public type: ConfigurationOptionType = 'boolean';
  public defaultValue: boolean = false;

  /**
   * Set the name of the option. **REQUIRED**
   * @param name {string} The name of the option. This is used to reference the option in the configuration file.
   */
  override setName<K extends string>(name: K): BooleanOption<K> {
    this.name = name as unknown as N;
    return this as unknown as BooleanOption<K>;
  }

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

export class ActionOption<N extends string = string> extends ConfigurationOption<N> {
  public type: ConfigurationOptionType = 'action';
  public manifest: Record<string, unknown> = {};
  public buttonText: string = 'Run';
  public taskName: string = '';

  /**
   * Set the name of the option. **REQUIRED**
   * @param name {string} The name of the option. This is used to reference the option in the configuration file.
   */
  override setName<K extends string>(name: K): ActionOption<K> {
    this.name = name as unknown as N;
    return this as unknown as ActionOption<K>;
  }

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
