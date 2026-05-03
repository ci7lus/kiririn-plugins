## programありTS

- 再生開始
  - initialNetworkTime: x
  - program.startAt: o
- TOT/PMT判明
  - initialNetworkTime: o
  - program.startAt: o

prerollが判明した後にvposが巻き戻る

## programなしTS

- 再生開始
  - initialNetworkTime: x
  - program.startAt x
- TOT/PMT判明
  - initialNetworkTime: o
  - program.startAt: o

vposがわかるようになるまで情報がないので

## programあり非TS

- 再生開始
  - initialNetworkTime: x
  - program.startAt o

preroll不明なのでoffsetでみるしか無いです

## programなし非TS

- 再生開始
  - initialNetworkTime: x
  - program.startAt x
