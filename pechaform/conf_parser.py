import yaml
from pathlib import Path


class ConfParse:
    def __init__(self, conf_file):
        self.conf = self.__parse_conf(conf_file)

    @staticmethod
    def __parse_conf(conf_file):
        f = Path(conf_file)
        conf = yaml.safe_load(f.read_text(encoding='utf-8'))

        # add tsv extension to files
        keys = list(conf['files'].keys())
        for k in keys:
            v = conf['files'][k]
            conf['files'].pop(k)
            conf['files'][k+'.tsv'] = v

        return conf
