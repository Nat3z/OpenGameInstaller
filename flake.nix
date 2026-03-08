{
  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";
    devenv.url = "github:cachix/devenv";
    devenv.inputs.nixpkgs.follows = "nixpkgs";
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = { self, nixpkgs, devenv, systems, ... } @ inputs:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in
    {
      packages = forEachSystem (system: {
        devenv-up = self.devShells.${system}.default.config.procfileScript;
        devenv-test = self.devShells.${system}.default.config.test;
      });

      devShells = forEachSystem
        (system:
          let
            pkgs = nixpkgs.legacyPackages.${system};
          in
          {
            default = devenv.lib.mkShell {
              inherit inputs pkgs;
              modules = [
                {
                  # https://devenv.sh/reference/options/
                  packages = with pkgs; [
                    # Runtime dependencies for the app on NixOS
                    electron
                    bun
                    git
                    libglibutil

                    # Wine for running Windows redistributables
                    wineWowPackages.stable

                    # SteamTinkerLaunch (used for Steam shortcut management on non-NixOS)
                    # On NixOS we skip "Add to Steam" so this is only for dev reference
                    steamtinkerlaunch

                    # UMU launcher — preferred over the bundled auto-download on NixOS
                    umu-launcher

                    # Native build tools
                    pkg-config
                    gcc
                  ];

                  enterShell = ''
                    echo "OpenGameInstaller dev shell"
                    echo "  bun:              $(bun --version)"
                    echo "  git:              $(git --version)"
                    echo "  electron:         available via ELECTRON_OVERRIDE_DIST_PATH"
                    echo "  umu-run:          $(which umu-run 2>/dev/null || echo 'not found')"
                    echo "  wine:             $(wine --version 2>/dev/null || echo 'not found')"
                    echo ""
                    echo "NixOS users: 'Add to Steam' is disabled — use umu-run for game compatibility."
                  '';

                  env.ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin/";
                }
              ];
            };
          });
    };
}
