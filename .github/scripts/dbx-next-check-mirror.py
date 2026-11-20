"""Verify that pushing the exact raw mirror commit cannot run its workflows."""

import re
import subprocess
import sys

import yaml


class UniqueKeysLoader(yaml.BaseLoader):
    def construct_mapping(self, node, deep=False):
        mapping = super().construct_mapping(node, deep)
        if len(mapping) != len(node.value):
            raise ValueError("Duplicate workflow keys")
        return mapping


def runs_on_push(trigger, branch):
    if isinstance(trigger, str):
        trigger = [trigger]
    if isinstance(trigger, list):
        return "push" in trigger or "create" in trigger
    if not isinstance(trigger, dict) or "create" in trigger:
        return True
    if "push" not in trigger:
        return False
    filters = trigger["push"]
    if not isinstance(filters, dict):
        return True
    if "branches" in filters:
        branches = filters["branches"]
        # Literal inclusions for other branches and slash-prefixed globs
        # cannot match the single-component upstream-main branch name.
        return not (
            isinstance(branches, list)
            and branches
            and all(
                name != branch
                and re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./*?+-]+)?", name)
                for name in branches
            )
        )
    if "branches-ignore" in filters:
        excluded = filters["branches-ignore"]
        return not (isinstance(excluded, list) and branch in excluded)
    tag_filter = filters.get("tags", filters.get("tags-ignore"))
    return not (isinstance(tag_filter, list) and tag_filter)


def read_git(*args):
    return subprocess.check_output(["git", "--no-replace-objects", *args]).decode("utf-8")


def main(commit):
    paths = read_git("ls-tree", "-rz", "--full-tree", "--name-only", commit, "--", ".github/workflows")
    checked = 0
    for path in paths.split("\0"):
        if not path.endswith((".yml", ".yaml")):
            continue
        source = read_git("show", commit + ":" + path)
        # Refuse YAML aliases and duplicate mappings so the decision does not
        # depend on how individual YAML parsers resolve an ambiguous trigger.
        if any(isinstance(token, (yaml.AliasToken, yaml.AnchorToken)) for token in yaml.scan(source)):
            raise ValueError(f"Cannot verify aliased workflow {path}")
        workflow = yaml.load(source, Loader=UniqueKeysLoader)
        if runs_on_push(workflow.get("on"), "upstream-main"):
            raise ValueError(f"Mirror push could run {path}")
        checked += 1
    print(f"Verified push triggers for {checked} upstream workflows")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except (KeyError, TypeError, ValueError, yaml.YAMLError) as error:
        sys.exit(str(error))
