import z, { ZodError } from "zod"

export interface ConfigurationFile {
  [key: string]: ConfigurationOption
}

const configValidation = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
})

export function isStringOption(option: ConfigurationOption): option is StringOption {
    return option.type === 'string';
  }

export function isNumberOption(option: ConfigurationOption): option is NumberOption {
  return option.type === 'number';
}

export function isBooleanOption(option: ConfigurationOption): option is BooleanOption {
  return option.type === 'boolean';
}

export class ConfigurationBuilder {
  private options: ConfigurationOption[] = [];
  public addNumberOption(option: (option: NumberOption) => NumberOption): ConfigurationBuilder {
    let newOption = new NumberOption();
    newOption = option(newOption);
    this.options.push(newOption);
    return this;
  }

  public addStringOption(option: (option: StringOption) => StringOption) {
    let newOption = new StringOption();
    newOption = option(newOption);
    this.options.push(newOption);
    return this;
  }

  public addBooleanOption(option: (option: BooleanOption) => BooleanOption) {
    let newOption = new BooleanOption();
    newOption = option(newOption);
    this.options.push(newOption);
    return this;
  }

  public build(includeFunctions: boolean): ConfigurationFile {
    let config: ConfigurationFile = {};
    this.options.forEach(option => {
      // remove all functions from the option object
      if (!includeFunctions) {
        option = JSON.parse(JSON.stringify(option));
        const optionData = configValidation.safeParse(option)
        if (!optionData.success) {
          throw new ZodError(optionData.error.errors)
        }

        config[option.name] = option;
      }
      else {
        config[option.name] = option;
      }
    });
    return config;
  }
}

export type ConfigurationOptionType = 'string' | 'number' | 'boolean' | 'unset'
export class ConfigurationOption {
  public name: string = '';
  public defaultValue: unknown = '';
  public displayName: string = '';
  public description: string = '';
  public type: ConfigurationOptionType = 'unset'
  
  setName(name: string) {
    this.name = name;
    return this;
  }

  setDisplayName(displayName: string) {
    this.displayName = displayName;
    return this;
  }

  setDescription(description: string) {
    this.description = description;
    return this;
  }


  validate(input: unknown): boolean {
    throw new Error('Validation code not implemented. Value: ' + input)
  };
}

export class StringOption extends ConfigurationOption {
  public allowedValues: string[] = [];
  public minTextLength: number = 0;
  public maxTextLength: number = Number.MAX_SAFE_INTEGER;
  public defaultValue: string = '';
  public type: ConfigurationOptionType = 'string'

  setAllowedValues(allowedValues: string[]): this {
    this.allowedValues = allowedValues;
    return this;
  }

  setDefaultValue(defaultValue: string): this {
    this.defaultValue = defaultValue;
    return this;
  }

  setMinTextLength(minTextLength: number): this {
    this.minTextLength = minTextLength;
    return this;
  }

  setMaxTextLength(maxTextLength: number): this {
    this.maxTextLength = maxTextLength;
    return this;
  }

  override validate(input: unknown): boolean {
    if (typeof input !== 'string') {
      return false;
    }
    if (this.allowedValues.length === 0 && input.length !== 0)
      return true;

    return this.allowedValues.includes(input);
  }
}

export class NumberOption extends ConfigurationOption {
  public min: number = 0;
  public max: number = Number.MAX_SAFE_INTEGER;
  public defaultValue: number = 0;
  public type: ConfigurationOptionType = 'number'

  setMin(min: number): this {
    this.min = min;
    return this;
  }

  setMax(max: number): this {
    this.max = max;
    return this
  }

  setDefaultValue(defaultValue: number): this {
    this.defaultValue = defaultValue;
    return this;
  }

  override validate(input: unknown): boolean {
    if (isNaN(Number(input))) {
      return false;
    }
    if (Number(input) < this.min || Number(input) > this.max) {
      return false;
    }
    return true;
  }

}

export class BooleanOption extends ConfigurationOption {
  public type: ConfigurationOptionType = 'boolean'
  public defaultValue: boolean = false;

  setDefaultValue(defaultValue: boolean): this {
    this.defaultValue = defaultValue;
    return this;
  }

  override validate(input: unknown): boolean {
    if (typeof input !== 'boolean') {
      return false;
    }
    return true;
  }

}