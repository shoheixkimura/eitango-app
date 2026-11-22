# (アプリ名)

家族（最大4人）で使う、英文フラッシュカードの Web アプリです。
Anki の .apkg ファイルを取り込み、FSRS（目標の記憶率 90%）で復習を管理します。
表に英文と音声、答えを見ると和訳。「もう一度／むずかしい／できた／かんたん」の4段階で自分で評価します。
家族ランキング（今週の学習カード数・連続学習日数）で、続けたくなるようにしています。

- ビルドなしの HTML / CSS / JavaScript（ES モジュール）。GitHub Pages でそのまま公開できます。
- オフラインでも学習できます（PWA）。記録は端末に保存し、つながったときに家族の端末と同期します。
- 仕様は [spec.md](spec.md) にあります。

## 使い方

1. 最初の画面で、学習する人の名前とアイコンを登録します（4人まで）。
2. 「設定 → 家族の合言葉と同期」で合言葉を決めます（「自動で作る」も使えます）。家族の端末すべてに同じ合言葉を入れます。
   2台目からは、最初の画面の「家族の合言葉で記録をよびだす」から入れられます。
3. 「設定 → .apkg を取り込む」で単語帳を取り込みます。どのフィールドを英文・和訳・音声・画像にするかを自動で推定し、プレビューを見て変えられます。
   取り込んだ単語帳は、裏でアップロードされ、同じ合言葉の端末すべてで使えます（ほかの端末ではホームの「ダウンロードする」）。
4. ホームの「学習をはじめる」で、今日の分（期限がきた復習＋新しいカード）を学習します。終わったら「新しいカードをあと10枚」で追加できます。

PC ではキーボードも使えます：スペース＝答えを見る（答えの画面では「できた」）、1〜4＝評価、R＝もう一度聞く。

### 対応する .apkg

- `collection.anki2` / `collection.anki21`（旧形式）
- `collection.anki21b`（新しい形式・zstd 圧縮）
- どれでもないときは「この形式は未対応です。Anki で『旧形式で書き出す』にチェックして書き出してください」と表示します。

同じ .apkg をもう一度取り込むと、同じ単語帳として上書きされ、学習記録はそのまま続きます（単語帳の ID は最上位のデッキ名から、カードの ID はノートの guid から決まります）。

### 日付を変えて試す

URL に `?date=2026-12-01` をつけると、その日として動きます（時刻は今の時刻のまま）。

### テスト

`tests.html` をブラウザでひらくと、FSRS の計算、日付と週の切りかわり、連続日数、2台の記録の合流、フィールドの推定、HTML を安全にする処理のテストが動きます。

ローカルで動かすとき（Service Worker と ES モジュールのため、ファイルを直接ひらくのではなくサーバーで）:

```bash
python3 -m http.server 8000
# http://localhost:8000/ と http://localhost:8000/tests.html
```

## Firebase の設定

漢字アプリと同じ Firebase プロジェクト（`dopakanji`）を使います。置き場所は漢字アプリと混ざらないように別にしています。

| 何を | どこに |
| --- | --- |
| 人の記録（名前・設定・日ごとの回答数） | Firestore `eitango_families/{合言葉のハッシュ}/profiles/{人のID}` |
| 各カードの FSRS の状態 | Firestore `eitango_families/{合言葉のハッシュ}/progress/{人のID}_{単語帳のID}` |
| 単語帳の一覧 | Firestore `eitango_families/{合言葉のハッシュ}/decks/{単語帳のID}` |
| 単語帳の本文と音声・画像 | Storage `eitango/{合言葉のハッシュ}/decks/{単語帳のID}/...` |

合言葉そのものはどこにも送りません（SHA-256 のハッシュだけを置き場所の名前に使います）。
市販教材の音声を扱うので、単語帳の中身は公開リポジトリや GitHub Pages には置かず、家族の合言葉の場所にだけ置きます。

### 1. Blaze プランに切り替える

Firebase Storage を使うには従量課金の Blaze プランが必要です（家族で使う量なら、ほぼ無料枠の中に収まる見込みです）。

1. [Firebase コンソール](https://console.firebase.google.com/) で `dopakanji` をひらく
2. 左下の「Spark」（プラン名）→「プランをアップグレード」→ Blaze を選ぶ
3. お支払いアカウント（クレジットカード）を選ぶか作る

### 2. 予算アラートを設定する（例：月100円）

予算アラートは「使いすぎたらメールで知らせる」しくみです（自動で止まるわけではありません）。

1. [Google Cloud コンソールの「お支払い」→「予算とアラート」](https://console.cloud.google.com/billing/budgets) をひらく
2. 「予算を作成」→ 名前（例：家族アプリ）、対象のプロジェクトに `dopakanji` を選ぶ
3. 金額を「指定した金額」で **100円** にする
4. しきい値を 50%・90%・100% にし、「請求先アカウントの管理者とユーザーにメールで通知」をオンにして保存

### 3. Storage を作る

1. Firebase コンソール →「構築」→「Storage」→「始める」
2. 場所は無料枠のあるリージョン（`US-CENTRAL1` など）を選ぶ。「本番環境モード」で作成
3. 「プロジェクトの設定」→「マイアプリ」の firebaseConfig にある `storageBucket` の値を、`js/cloud-config.js` の `storageBucket` に写す
   （いまは `dopakanji.firebasestorage.app` を入れてあります。ちがう値だったら差しかえてください）

### 4. Storage のルールを追加する

Storage の「ルール」タブに [`firebase/storage.rules`](firebase/storage.rules) の内容をはりつけて「公開」します。

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /eitango/{fam}/decks/{deck}/{file=**} {
      allow get: if fam.size() == 64;
      allow create: if fam.size() == 64
        && request.resource.size < 20 * 1024 * 1024; // 1ファイル 20MB まで
      allow list, update, delete: if false;
    }
  }
}
```

`eitango/` の下だけ、1ファイルずつの読み取りと新しいファイルの作成ができます。上書き・一覧・削除はできません。

### 5. Firestore のルールを追加する

Firestore の「ルール」タブで、**いまある漢字アプリのルールは消さずに**、`match /databases/{database}/documents { … }` の中に次のかたまりを追加して「公開」します（全体の例は [`firebase/firestore.rules`](firebase/firestore.rules)）。

```
    match /eitango_families/{fam}/{col}/{doc} {
      allow read: if fam.size() == 64 && col in ['profiles', 'progress', 'decks'];
      allow create, update: if fam.size() == 64 && col in ['profiles', 'progress', 'decks']
        && request.resource.data.keys().hasOnly(['json', 'updated'])
        && request.resource.data.json is string
        && request.resource.data.json.size() < 1000000;
      allow delete: if false;
    }
```

読み取り・作成・更新はでき、削除はできません。

### 消したいとき

アプリからは、クラウドの記録や単語帳は消せません（「外す」は端末の一覧から外すだけです）。
完全に消すときは、管理者が Firebase コンソールの Firestore（`eitango_families`）と Storage（`eitango/`）から消します。

## しくみのメモ

- 記録は端末の localStorage（人の記録 `eitango.v1`、カードの記録 `eitango.prog.{人のID}_{単語帳のID}`）、単語帳の本文と音声・画像は IndexedDB（`eitango`）に保存します。
- 2台で同時に使ったときは、カードごとに「復習回数が多いほう（同じなら最後に答えたのが新しいほう）」、日ごとの回答数は多いほうを採用します。
- 1回ごとの回答の履歴はクラウドに送りません。
- 連続学習日数は「その日の分（期限の復習＋新しいカード）を終えた日」が続いた日数です。今日まだでも、昨日まで続いていれば数は消えません。
- 週は月曜0時（端末の現地時間）に切りかわります。
- Service Worker のキャッシュ名は `eitango-v{バージョン}` です。新しい版を出すときは `js/config.js` の `VERSION` と `sw.js` の `CACHE` を上げます。
  同じ `github.io` のドメインにある漢字アプリが更新されると、このアプリのオフライン用キャッシュが消えることがありますが、次にネットにつながったときに自動で入れなおします（単語帳と記録は消えません）。

## ライセンス

このアプリが使っているライブラリ（`vendor/` に同梱。全文は各 LICENSE ファイル）:

- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) 5.4.2 — MIT License, © Open Spaced Repetition（`vendor/LICENSE-ts-fsrs.txt`）
- [fflate](https://github.com/101arrowz/fflate) 0.8.3 — MIT License, © Arjun Barrett（`vendor/LICENSE-fflate.txt`）
- [fzstd](https://github.com/101arrowz/fzstd) 0.1.1 — MIT License, © Arjun Barrett（`vendor/LICENSE-fzstd.txt`）
- [sql.js](https://github.com/sql-js/sql.js) 1.17.0 — MIT License（`vendor/LICENSE-sql.js.txt`）。SQLite はパブリックドメイン

Anki は Ankitects Pty Ltd の製品です。このアプリは Anki とは関係のない別のアプリで、.apkg ファイルを読みこむだけです。
単語帳の中身（英文・音声）の権利は、それぞれの教材の作者にあります。
