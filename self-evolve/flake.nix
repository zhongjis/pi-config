{
  description = "Self-evolve Module 1 scaffold";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          python = pkgs.python313.withPackages (ps: [
            ps.jinja2
            ps.pytest
          ]);
        in {
          default = pkgs.mkShellNoCC {
            packages = [
              python
              pkgs.sqlite
            ];

            shellHook = ''
              export PYTHONPATH="$PWD/src''${PYTHONPATH:+:$PYTHONPATH}"
              echo "self-evolve Module 1 dev shell"
              echo "Run pytest or python -c 'import self_evolve'"
            '';
          };
        });

      checks = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          python = pkgs.python313;
        in {
          import-smoke = pkgs.runCommand "self-evolve-import-smoke" {
            buildInputs = [ python ];
          } ''
            export PYTHONPATH="${self}/src"
            python -c "import self_evolve"
            touch "$out"
          '';
        });
    };
}
