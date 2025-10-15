from pechaform import parse_bo_docs, parse_trans_docs_padmakara, parse_trans_docs, parse_trans_docs_updated


if __name__ == '__main__':
    mode = 2

    if mode == 1:
        print('parsing Tibetan texts')

        conf = 'texts_bo_conf.yaml'
        parse_bo_docs(conf)

    elif mode == 2:
        print('parsing translations')

        conf = 'texts_trans_conf.yaml'
        parse_trans_docs_updated(conf)

    else:
        raise NotImplemented('This mode is not implemented.\n\n\tTibetan: 1\n\ttranslations: 2')
