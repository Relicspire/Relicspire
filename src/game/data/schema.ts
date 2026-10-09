import type { DataIssue } from './validation';
/** 未知の値・データパス・エラー蓄積先を受け取る検証関数。問題をissuesへ追加する。 */
export type Check = (value: unknown, path: string, issues: DataIssue[]) => void;
/**
 * データパスと検証理由をエラー配列へ追加する。
 *
 * @param issues 検出した問題の蓄積先。
 * @param path 問題箇所を示すデータパス。
 * @param message 検証エラーの説明文。
 */
export const fail = (issues: DataIssue[], path: string, message: string) => {
  issues.push({ path, message });
};
/**
 * 上下限を満たす安全な整数の検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param min 許可する下限（含む）。
 * @param max 許可する上限（含む）。
 */
export const integer =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v, p, e) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
      fail(e, p, `Expected integer ${min}..${max}`);
  };
/**
 * 指定した値のいずれかに一致する検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param values 許可する値の一覧。
 */
export const choice =
  (...values: readonly unknown[]): Check =>
  (v, p, e) => {
    if (!values.includes(v)) fail(e, p, `Expected ${values.join(' | ')}`);
  };
/** 真偽値だけを受け入れる検証関数。 */
export const bool: Check = choice(true, false);
/**
 * 指定正規表現に一致する文字列IDの検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param pattern 文字列全体への一致に使う正規表現。
 */
export const id =
  (pattern: RegExp): Check =>
  (v, p, e) => {
    if (typeof v !== 'string' || !pattern.test(v)) fail(e, p, 'Invalid ID');
  };
/**
 * 配列の長さと全要素を検証する関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param item 配列の各要素に適用する検証関数。
 * @param min 許可する配列長の下限。
 * @param max 許可する配列長の上限。
 */
export const array =
  (item: Check, min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v, p, e) => {
    if (!Array.isArray(v)) return fail(e, p, 'Expected array');
    if (v.length < min || v.length > max)
      fail(e, p, `Expected ${min}..${max} items`);
    v.forEach((x, i) => item(x, `${p}[${i}]`, e));
  };
/**
 * 必須・任意項目を検証し、未知のキーを拒否するオブジェクト検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param fields 項目名と検証関数の対応表。
 * @param optional 省略を許可する項目名。
 */
export const object =
  (fields: Record<string, Check>, optional: string[] = []): Check =>
  (v, p, e) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      return fail(e, p, 'Expected object');
    const data = v as Record<string, unknown>;
    for (const key of Object.keys(data))
      if (!Object.hasOwn(fields, key))
        fail(e, `${p}.${key}`, 'Unsupported field');
    for (const [key, check] of Object.entries(fields))
      if (Object.hasOwn(data, key) || !optional.includes(key))
        check(data[key], `${p}.${key}`, e);
  };
/**
 * 候補のいずれかに適合する値を検証する。全候補不適合なら問題数が最少の候補のエラーを返す。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param checks いずれか1つを満たせばよい検証関数の一覧。
 */
export const union =
  (checks: Check[]): Check =>
  (v, p, e) => {
    const failures = checks.map((check) => {
      const errors: DataIssue[] = [];
      check(v, p, errors);
      return errors;
    });
    if (!failures.some((errors) => errors.length === 0))
      e.push(...failures.reduce((a, b) => (a.length <= b.length ? a : b)));
  };
