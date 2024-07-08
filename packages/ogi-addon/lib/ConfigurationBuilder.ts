import OGIAddon from "../main";
import z, { ZodError } from "zod"

export interface ConfigurationFile {
  [key: string]: any;
}

const configValidation = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
})

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

  public build(): ConfigurationFile {
    let config: ConfigurationFile = {};
    this.options.forEach(option => {
      // remove all functions from the option object
      option = JSON.parse(JSON.stringify(option));
      const optionData = configValidation.safeParse(option)
      if (!optionData.success) {
        throw new ZodError(optionData.error.errors)
      }

      config[option.name] = option;
    });
    return config;
  }
}

export type ConfigurationOptionType = 'string' | 'number' | 'unset'
export class ConfigurationOption {
  public name: string = '';
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


  validate(input: string): boolean {
    throw new Error('Validation not implemented')
  };
}

class StringOption extends ConfigurationOption {
  public allowedValues: string[] = [];
  public type: ConfigurationOptionType = 'string'

  setAllowedValues(allowedValues: string[]) {
    this.allowedValues = allowedValues;
    return this;
  }

  override validate(input: string): boolean {
    if (this.allowedValues.length === 0 && input.length !== 0)
      return true;

    return this.allowedValues.includes(input);
  }
}

class NumberOption extends ConfigurationOption {
  public min: number = 0;
  public max: number = Number.MAX_SAFE_INTEGER;
  public type: ConfigurationOptionType = 'number'

  setMin(min: number) {
    this.min = min;
    return this;
  }

  setMax(max: number) {
    this.max = max;
    return this
  }

  override validate(input: string): boolean {
    if (isNaN(Number(input))) {
      return false;
    }
    return true;
  }

}